"""
WhatIfStudio pipeline - render manifest for one cut: episodes/<cut>/logs/manifest.json

    python tools/pipeline/manifest.py start  --config <cfg>            # before the first render chunk
    python tools/pipeline/manifest.py start  --config <cfg> --adopt    # existing frames: trust them as this render
    python tools/pipeline/manifest.py update --config <cfg>            # after each chunk: scan, validate, record
    python tools/pipeline/manifest.py show   --config <cfg>

The manifest records the render_id, the config hash, the expected range and, per frame, size, dimensions, sha1,
mtime and status. Frames older than `started_at` are stale (left over from an earlier render) unless --adopt was used.
If the config changes, `start` refuses; `start --replace` archives the old manifest (the old frames then show as stale).
Written atomically, so an interrupted run never leaves a half-written manifest. Never touches frames.
Exit 0 = ok, 1 = frames have errors, 2 = config / manifest problem.
"""
from __future__ import annotations

import argparse
import json
import sys
import time
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import ROOT, ConfigError, atomic_write_json, compress_ranges, config_hash, cut_dir, load_config  # noqa: E402

SCHEMA = 1


class ManifestError(RuntimeError):
    pass


def manifest_path(cfg: dict, root=ROOT) -> Path:
    return cut_dir(cfg, root) / "logs" / "manifest.json"


def read_manifest(path) -> dict | None:
    path = Path(path)
    if not path.exists():
        return None
    try:
        m = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as e:
        raise ManifestError(f"cannot read manifest {path}: {e}") from e
    if not isinstance(m, dict) or m.get("schema") != SCHEMA:
        raise ManifestError(f"{path} is not a schema-{SCHEMA} manifest")
    return m


def _iso(t: float) -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime(t))


def start(cfg: dict, root=ROOT, adopt: bool = False, replace: bool = False, now: float | None = None) -> dict:
    """Create the manifest. Idempotent for an unchanged config; refuses a changed one unless replace=True."""
    path = manifest_path(cfg, root)
    h = config_hash(cfg)
    old = read_manifest(path)
    if old is not None:
        if old["config_hash"] == h and not replace:
            return old
        if not replace:
            raise ManifestError(
                f"config changed since render {old['render_id']} (hash {old['config_hash']} -> {h}). "
                "Frames in this cut folder belong to the old config. Use a new cut folder, "
                "or `start --replace` to archive the old manifest (existing frames will then be flagged stale).")
        path.rename(path.with_name(f"manifest_{old['render_id']}.json"))
    now = time.time() if now is None else now
    m = {
        "schema": SCHEMA,
        "render_id": uuid.uuid4().hex[:12],
        "cut": cfg["cut"],
        "config_hash": h,
        "config": cfg,
        "adopted": adopt,
        "started_at": None if adopt else now,
        "created": _iso(now),
        "updated": _iso(now),
        "expected": {"start": cfg["frame_start"], "end": cfg["frame_end"],
                     "count": cfg["frame_end"] - cfg["frame_start"] + 1,
                     "width": cfg["width"], "height": cfg["height"]},
        "frames": {},
        "missing": list(range(cfg["frame_start"], cfg["frame_end"] + 1)),
        "summary": {},
    }
    atomic_write_json(path, m)
    return m


def update(cfg: dict, root=ROOT, frames_dir=None, now: float | None = None):
    """Scan + validate the frames and record the result. Returns (manifest, report)."""
    from validate_frames import validate
    path = manifest_path(cfg, root)
    m = read_manifest(path)
    if m is None:
        raise ManifestError(f"no manifest at {path}; run `manifest.py start` first")
    if m["config_hash"] != config_hash(cfg):
        raise ManifestError(f"config changed since render {m['render_id']}; refusing to mix frames. "
                            "Use a new cut folder or `start --replace`.")
    frames_dir = Path(frames_dir) if frames_dir else cut_dir(cfg, root) / "frames"
    rep = validate(cfg, frames_dir, since=m["started_at"])
    m["frames"] = {str(n): {"file": Path(f.path).name, "size": f.size, "width": f.width, "height": f.height,
                            "sha1": f.sha1, "mtime": f.mtime, "status": "ok" if not f.codes else ",".join(f.codes)}
                   for n, f in sorted(rep.frames.items())}
    m["missing"] = rep.missing()
    bad = sorted(n for n, f in rep.frames.items() if f.codes)
    m["summary"] = {"ok": rep.ok, "complete": sum(1 for f in rep.frames.values() if not f.codes),
                    "missing": len(m["missing"]), "invalid": bad,
                    "errors": len(rep.errors), "warnings": len(rep.warnings)}
    m["updated"] = _iso(time.time() if now is None else now)
    atomic_write_json(path, m)
    return m, rep


def describe(m: dict) -> str:
    s, e = m["summary"], m["expected"]
    lines = [f"[manifest] cut {m['cut']}  render {m['render_id']}  config {m['config_hash']}"
             f"{'  (adopted existing frames)' if m['adopted'] else ''}",
             f"  expected {e['start']}-{e['end']} ({e['count']} frames, {e['width']}x{e['height']})  updated {m['updated']}"]
    if s:
        lines.append(f"  complete {s['complete']}/{e['count']}  missing {s['missing']}  invalid {len(s['invalid'])}")
        if m["missing"]:
            lines.append(f"  missing: {compress_ranges(m['missing'])}")
        if s["invalid"]:
            lines.append(f"  invalid: {compress_ranges(s['invalid'])}")
    else:
        lines.append("  not scanned yet: run `manifest.py update`")
    return "\n".join(lines)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("command", choices=("start", "update", "show"))
    ap.add_argument("--config", required=True)
    ap.add_argument("--root", default=str(ROOT))
    ap.add_argument("--frames", help="frames folder (default episodes/<cut>/frames)")
    ap.add_argument("--adopt", action="store_true", help="start: treat frames already on disk as part of this render")
    ap.add_argument("--replace", action="store_true", help="start: archive a manifest made for a different config")
    args = ap.parse_args(argv)
    try:
        cfg = load_config(args.config)
        if args.command == "start":
            print(describe(start(cfg, args.root, adopt=args.adopt, replace=args.replace)))
            return 0
        if args.command == "update":
            from validate_frames import summarize
            m, rep = update(cfg, args.root, frames_dir=args.frames)
            print(summarize(rep))
            print(describe(m))
            return 0 if rep.ok else 1
        m = read_manifest(manifest_path(cfg, args.root))
        if m is None:
            raise ManifestError("no manifest yet; run `manifest.py start`")
        print(describe(m))
        return 0
    except (ConfigError, ManifestError) as e:
        print(f"[manifest] {e}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
