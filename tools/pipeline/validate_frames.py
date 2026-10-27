"""
WhatIfStudio pipeline - validate a rendered PNG sequence against its cut config. Read-only: never moves or deletes frames.

    python tools/pipeline/validate_frames.py --config configs/ai_disappeared_final_30fps.json
    python tools/pipeline/validate_frames.py --config <cfg> --frames D:\\elsewhere\\frames --json report.json

Errors (exit 1): missing / extra / duplicate frame numbers, empty, unreadable or non-PNG files, wrong size or colour
mode, black frames (outside dark_ranges), undersized files, frames older than the render manifest (stale).
Warnings: stray files, non-4-digit names, identical consecutive frames.
Exit 0 = clean, 1 = errors found, 2 = bad config or usage.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import statistics
import sys
from dataclasses import asdict, dataclass, field
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import (ROOT, ConfigError, Issue, compress_ranges, config_hash, cut_dir, load_config,  # noqa: E402
                    scan_frames)

from PIL import Image, ImageStat  # noqa: E402

SIZE_WINDOW = 15     # frames either side used for the local median file size
STALE_TOLERANCE = 2.0   # seconds; file-system timestamps can lag the clock slightly (coarse mtime, FAT/exFAT 2 s)


@dataclass
class FrameInfo:
    number: int
    path: str
    size: int
    mtime: float
    width: int | None = None
    height: int | None = None
    mode: str | None = None
    mean_luma: float | None = None
    sha1: str | None = None
    codes: list = field(default_factory=list)    # error codes for this frame; empty = ok


@dataclass
class Report:
    frames_dir: str
    expected_start: int
    expected_end: int
    frames: dict = field(default_factory=dict)   # number -> FrameInfo
    issues: list = field(default_factory=list)

    @property
    def errors(self):
        return [i for i in self.issues if i.severity == "error"]

    @property
    def warnings(self):
        return [i for i in self.issues if i.severity == "warning"]

    @property
    def ok(self) -> bool:
        return not self.errors

    def missing(self):
        return sorted(i.frame for i in self.issues if i.code == "missing")

    def to_dict(self) -> dict:
        return {"frames_dir": self.frames_dir, "expected": [self.expected_start, self.expected_end],
                "ok": self.ok, "issues": [asdict(i) for i in self.issues],
                "frames": {str(n): asdict(f) for n, f in sorted(self.frames.items())}}


def inspect_frame(number: int, path: Path) -> tuple[FrameInfo, str | None]:
    """Read one PNG fully. Returns (info, error_code or None)."""
    st = path.stat()
    info = FrameInfo(number=number, path=str(path), size=st.st_size, mtime=st.st_mtime)
    if st.st_size == 0:
        return info, "empty"
    data = path.read_bytes()
    info.sha1 = hashlib.sha1(data).hexdigest()
    try:
        with Image.open(path) as im:
            fmt = im.format
            im.verify()                       # chunk structure + CRCs
        if fmt != "PNG":
            return info, "not_png"
        with Image.open(path) as im:
            im.load()                         # full decode: catches truncated pixel data
            info.width, info.height, info.mode = im.width, im.height, im.mode
            small = im.convert("L").reduce(4) if min(im.size) >= 8 else im.convert("L")
            info.mean_luma = round(ImageStat.Stat(small).mean[0], 2)
    except Exception:                         # Pillow raises OSError/SyntaxError/ValueError/... for bad files
        return info, "unreadable"
    return info, None


def validate(cfg: dict, frames_dir, since: float | None = None) -> Report:
    """Check frames_dir against cfg. `since`: epoch seconds; frames modified before it are stale."""
    frames_dir = Path(frames_dir)
    a, b = cfg["frame_start"], cfg["frame_end"]
    rep = Report(frames_dir=str(frames_dir), expected_start=a, expected_end=b)
    add = rep.issues.append
    if not frames_dir.is_dir():
        add(Issue("missing_dir", "error", path=str(frames_dir), detail="frames folder does not exist"))
        return rep

    found, strays = scan_frames(frames_dir, cfg["frame_prefix"])
    for p in strays:
        add(Issue("stray_file", "warning", path=str(p), detail="not a frame name; ignored"))
    for n in range(a, b + 1):
        if n not in found:
            add(Issue("missing", "error", frame=n))
    for n in sorted(found):
        if not a <= n <= b:
            add(Issue("extra", "error", frame=n, path=str(found[n][0]),
                      detail=f"outside expected range {a}-{b} (left over from another cut?)"))
    dark = [range(lo, hi + 1) for lo, hi in cfg["dark_ranges"]]

    for n in sorted(k for k in found if a <= k <= b):
        paths = found[n]
        if len(paths) > 1:
            add(Issue("duplicate_number", "error", frame=n, detail=", ".join(p.name for p in paths)))
        p = paths[0]
        info, err = inspect_frame(n, p)
        rep.frames[n] = info
        if len(paths) > 1:
            info.codes.append("duplicate_number")
        if not p.name.lower() == f"{cfg['frame_prefix']}{n:04d}.png".lower():
            add(Issue("nonstandard_name", "warning", frame=n, path=str(p), detail="expected 4-digit padding"))
        if err:
            info.codes.append(err)
            add(Issue(err, "error", frame=n, path=str(p)))
            continue
        if (info.width, info.height) != (cfg["width"], cfg["height"]):
            info.codes.append("wrong_size")
            add(Issue("wrong_size", "error", frame=n, path=str(p),
                      detail=f"{info.width}x{info.height}, expected {cfg['width']}x{cfg['height']}"))
        if info.mode != cfg["color_mode"]:
            info.codes.append("wrong_mode")
            add(Issue("wrong_mode", "error", frame=n, path=str(p), detail=f"{info.mode}, expected {cfg['color_mode']}"))
        if info.mean_luma < cfg["black_threshold"] and not any(n in r for r in dark):
            info.codes.append("black")
            add(Issue("black", "error", frame=n, path=str(p), detail=f"mean luma {info.mean_luma}"))
        if since is not None and info.mtime < since - STALE_TOLERANCE:
            info.codes.append("stale")
            add(Issue("stale", "error", frame=n, path=str(p), detail="older than the current render manifest"))

    # undersized: much smaller than nearby frames (a crashed or blank render compresses to almost nothing)
    sizes = {n: f.size for n, f in rep.frames.items() if f.sha1}
    for n, size in sizes.items():
        near = [s for k, s in sizes.items() if k != n and abs(k - n) <= SIZE_WINDOW]
        if len(near) >= 3 and size < cfg["min_size_ratio"] * statistics.median(near):
            rep.frames[n].codes.append("undersized")
            add(Issue("undersized", "error", frame=n, path=rep.frames[n].path,
                      detail=f"{size} bytes vs local median {int(statistics.median(near))}"))

    # identical consecutive frames: legal for a static hold, but often a copy-paste mistake
    nums = sorted(rep.frames)
    for prev, n in zip(nums, nums[1:]):
        f0, f1 = rep.frames[prev], rep.frames[n]
        if n == prev + 1 and f0.sha1 and f0.sha1 == f1.sha1:
            add(Issue("repeated_frame", "warning", frame=n, detail=f"identical to frame {prev}"))
    rep.issues.sort(key=lambda i: (i.severity != "error", i.code, i.frame if i.frame is not None else -1))
    return rep


def summarize(rep: Report) -> str:
    lines = [f"[validate] {rep.frames_dir}: expected {rep.expected_start}-{rep.expected_end} "
             f"({rep.expected_end - rep.expected_start + 1} frames), found {len(rep.frames)} in range"]
    by_code = {}
    for i in rep.issues:
        by_code.setdefault((i.severity, i.code), []).append(i)
    for (sev, code), items in sorted(by_code.items(), key=lambda kv: (kv[0][0] != "error", kv[0][1])):
        frames = [i.frame for i in items if i.frame is not None]
        where = compress_ranges(frames) if frames else "; ".join(i.path or i.detail for i in items[:5])
        lines.append(f"  {sev.upper():7} {code:17} x{len(items)}: {where}")
    lines.append("[validate] OK" if rep.ok else f"[validate] FAILED: {len(rep.errors)} error(s)")
    return "\n".join(lines)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--config", required=True)
    ap.add_argument("--root", default=str(ROOT))
    ap.add_argument("--frames", help="frames folder (default episodes/<cut>/frames)")
    ap.add_argument("--json", help="also write the full report to this file")
    ap.add_argument("--no-manifest", action="store_true", help="skip the stale-frame check against the manifest")
    args = ap.parse_args(argv)
    try:
        cfg = load_config(args.config)
    except ConfigError as e:
        print(f"[validate] config error: {e}", file=sys.stderr)
        return 2
    frames_dir = Path(args.frames) if args.frames else cut_dir(cfg, args.root) / "frames"
    m = None
    if not args.no_manifest:
        from manifest import ManifestError, manifest_path, read_manifest
        try:
            m = read_manifest(manifest_path(cfg, args.root))
        except ManifestError as e:
            print(f"[validate] {e}", file=sys.stderr)
            return 2
    rep = validate(cfg, frames_dir, since=m["started_at"] if m else None)
    if m and m["config_hash"] != config_hash(cfg):
        rep.issues.insert(0, Issue("manifest_mismatch", "error", detail=(
            f"manifest {m['render_id']} was made for config {m['config_hash']}, not {config_hash(cfg)}")))
    print(summarize(rep))
    if args.json:
        Path(args.json).write_text(json.dumps(rep.to_dict(), indent=2), encoding="utf-8")
    return 0 if rep.ok else 1


if __name__ == "__main__":
    sys.exit(main())
