"""
WhatIfStudio pipeline - preflight before a production render or assembly. Read-only: renders, saves and moves nothing.

    python tools/pipeline/preflight.py --config configs/ai_disappeared_final_30fps.json
    python tools/pipeline/preflight.py --config <cfg> --strict          # warnings count as failures

Checks Python + Pillow, ffmpeg/ffprobe (and libx264), the required scripts, the scene .blend (present, a real
Blender file, not a Git LFS pointer), the cut folders (writable), free disk space for the frames still to render,
the render manifest, leftovers from interrupted runs, and - if blender_snapshot.py has been run in Blender - the
scene's actual render settings and picture-lock state against the config.
Exit 0 = ready (warnings allowed), 1 = not ready, 2 = bad config.
"""
from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import (ROOT, ConfigError, ToolError, config_hash, cut_dir, find_tool, frame_count,  # noqa: E402
                    load_config, scan_frames)
from manifest import ManifestError, manifest_path, read_manifest  # noqa: E402
from snapshot_check import compare  # noqa: E402

PIPELINE_FILES = ["tools/pipeline/common.py", "tools/pipeline/manifest.py", "tools/pipeline/validate_frames.py",
                  "tools/pipeline/assemble_safe.py", "tools/pipeline/verify_mp4.py",
                  "tools/pipeline/blender_snapshot.py"]
BLEND_MAGIC = (b"BLENDER", b"\x28\xb5\x2f\xfd", b"\x1f\x8b")       # plain, zstd-compressed, gzip-compressed
LFS_POINTER = b"version https://git-lfs"
MB = 1024 * 1024


def _tool_version(exe: str) -> str:
    r = subprocess.run([exe, "-hide_banner", "-version"], capture_output=True, text=True, timeout=30)
    return (r.stdout.splitlines() or ["?"])[0] if r.returncode == 0 else ""


def check_blend(path: Path):
    if not path.is_file():
        return "fail", f"{path} not found"
    head = path.open("rb").read(64)
    if head.startswith(LFS_POINTER):
        return "fail", f"{path} is a Git LFS pointer, not the scene (run `git lfs pull`)"
    if not head.startswith(BLEND_MAGIC):
        return "fail", f"{path} does not look like a .blend file"
    return "ok", f"{path} ({path.stat().st_size / MB:.1f} MB)"


def _writable(d: Path) -> bool:
    try:
        with tempfile.TemporaryFile(dir=d):
            return True
    except OSError:
        return False


def _existing_parent(p: Path) -> Path:
    while not p.exists() and p != p.parent:
        p = p.parent
    return p


def run_checks(cfg: dict, root=ROOT, snapshot=None, disk_usage=shutil.disk_usage) -> list:
    """List of (status, name, detail); status 'ok' | 'warn' | 'fail'."""
    root = Path(root)
    res = []
    add = lambda st, name, detail: res.append((st, name, detail))  # noqa: E731

    add("ok" if sys.version_info >= (3, 9) else "fail", "python", sys.version.split()[0])
    try:
        import PIL
        add("ok", "pillow", PIL.__version__)
    except ImportError:
        add("fail", "pillow", "not installed: python -m pip install -r requirements-dev.txt")

    for tool in ("ffmpeg", "ffprobe"):
        try:
            exe = find_tool(tool, cfg)
            ver = _tool_version(exe)
            add("ok" if ver else "fail", tool, ver or f"{exe} did not run")
            if tool == "ffmpeg" and ver:
                enc = subprocess.run([exe, "-hide_banner", "-encoders"], capture_output=True, text=True, timeout=30)
                add("ok" if " libx264 " in enc.stdout else "fail", "libx264", "available" if " libx264 " in enc.stdout
                    else "this ffmpeg build has no libx264 encoder")
        except (ToolError, OSError, subprocess.SubprocessError) as e:
            add("fail", tool, str(e))

    missing = [f for f in PIPELINE_FILES + list(cfg.get("required_files", [])) if not (root / f).is_file()]
    add("fail" if missing else "ok", "required files", ", ".join(missing) if missing
        else f"{len(PIPELINE_FILES) + len(cfg.get('required_files', []))} present")

    if cfg.get("blend"):
        add(*(lambda s: (s[0], "scene .blend", s[1]))(check_blend(root / cfg["blend"])))
    else:
        add("warn", "scene .blend", "config has no 'blend' entry")

    cdir = cut_dir(cfg, root)
    for sub in ("frames", "output", "logs"):
        d = cdir / sub
        if not d.exists():
            add("warn", f"{sub}/", f"{d} does not exist yet (created on first render / assembly)")
        else:
            add("ok" if _writable(d) else "fail", f"{sub}/", f"{d} {'writable' if _writable(d) else 'NOT writable'}")

    # frames still to render -> disk space
    frames_dir = cdir / "frames"
    found = scan_frames(frames_dir, cfg["frame_prefix"])[0] if frames_dir.is_dir() else {}
    todo = sum(1 for n in range(cfg["frame_start"], cfg["frame_end"] + 1) if n not in found)
    need = todo * cfg.get("est_frame_mb", 1.5) * MB + 300 * MB          # + room for the encode and logs
    free = disk_usage(_existing_parent(cdir)).free
    st = "fail" if free < need else ("warn" if free < 2 * need else "ok")
    add(st, "disk space", f"{free / MB / 1024:.1f} GB free, about {need / MB / 1024:.1f} GB needed "
                          f"({todo} of {frame_count(cfg)} frames still to render)")

    try:
        m = read_manifest(manifest_path(cfg, root))
    except ManifestError as e:
        m = None
        add("fail", "manifest", str(e))
    else:
        if m is None:
            add("warn", "manifest", (f"none yet, but {len(found)} frames are already in frames/: run "
                                     "`manifest.py start --adopt` if they belong to this render, else use a new "
                                     "cut folder") if found else "none yet: run `manifest.py start` before rendering")
        elif m["config_hash"] != config_hash(cfg):
            add("fail", "manifest", f"render {m['render_id']} used different render settings; frames would mix. "
                                    "Render into a new cut folder or `manifest.py start --replace`")
        else:
            s = m.get("summary") or {}
            add("ok", "manifest", f"render {m['render_id']}" + (f", {s.get('complete')} complete, "
                                                                f"{s.get('missing')} missing" if s else ""))

    out_dir = cdir / "output"
    leftovers = sorted(out_dir.glob("*.partial.mp4")) if out_dir.is_dir() else []
    if leftovers:
        add("warn", "leftovers", f"{len(leftovers)} .partial.mp4 from interrupted encodes (safe to delete): "
                                 + ", ".join(p.name for p in leftovers[:3]))

    snap_path = Path(snapshot) if snapshot else cdir / "logs" / "blender_snapshot.json"
    if not snap_path.is_file():
        add("warn", "blender settings", f"not verified: no {snap_path.name}. In Blender run "
                                        "tools/pipeline/blender_snapshot.py (read-only), then preflight again")
    else:
        try:
            snap = json.loads(snap_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as e:
            add("fail", "blender settings", f"cannot read {snap_path}: {e}")
        else:
            add("ok", "snapshot", f"{snap_path.name} taken {snap.get('taken_at')} in Blender "
                                  f"{snap.get('blender_version')}")
            res += [(st, f"blender: {name}", detail) for st, name, detail in compare(cfg, snap)]
    return res


def report(results) -> str:
    mark = {"ok": "  OK ", "warn": " WARN", "fail": " FAIL"}
    return "\n".join(f"{mark[st]}  {name:24} {detail}" for st, name, detail in results)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--config", required=True)
    ap.add_argument("--root", default=str(ROOT))
    ap.add_argument("--snapshot", help="blender_snapshot.json (default episodes/<cut>/logs/blender_snapshot.json)")
    ap.add_argument("--strict", action="store_true", help="treat warnings as failures")
    args = ap.parse_args(argv)
    try:
        cfg = load_config(args.config)
    except ConfigError as e:
        print(f"[preflight] config error: {e}", file=sys.stderr)
        return 2
    results = run_checks(cfg, args.root, args.snapshot)
    print(f"[preflight] cut {cfg['cut']}: {frame_count(cfg)} frames {cfg['width']}x{cfg['height']} @ {cfg['fps']} fps, "
          f"audio {cfg['audio']}")
    print(report(results))
    fails = [r for r in results if r[0] == "fail" or (args.strict and r[0] == "warn")]
    print("[preflight] READY" if not fails else f"[preflight] NOT READY: {len(fails)} problem(s)")
    return 0 if not fails else 1


if __name__ == "__main__":
    sys.exit(main())
