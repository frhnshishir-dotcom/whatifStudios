"""
WhatIfStudio pipeline - safe recovery after an interrupted render. Never renders; prints what to render next.

    python tools/pipeline/resume.py --config configs/ai_disappeared_final_30fps.json
    python tools/pipeline/resume.py --config <cfg> --quarantine       # move bad frames aside (never deletes)

1. Scans the frames and updates the render manifest (refuses if the render settings changed: no mixing).
2. Lists frames to (re)render, grouped into chunks that never cross a shot boundary or exceed max_chunk frames.
3. Prints a guarded Blender snippet per chunk for the open session (MCP), non-blocking, as CLAUDE.md describes.
   It checks size, fps, output folder and use_overwrite=False before it starts, refuses if a render is already
   running, and restores frame_start/frame_end when the chunk finishes or is cancelled.
Bad frames that exist on disk (black, wrong size, unreadable, stale, out of range, duplicate names) block the
re-render, because use_overwrite=False skips existing files. --quarantine moves them to
episodes/<cut>/logs/rejected_<time>/ with a moved.json record; it refuses to move more than half the sequence
unless --force (that usually means a forgotten `manifest.py start --adopt`).
It never runs, or suggests running, tools/final/picture_lock.py.
Exit 0 = sequence complete, 1 = work remains, 2 = config / manifest problem.
"""
from __future__ import annotations

import argparse
import json
import shutil
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import ROOT, ConfigError, atomic_write_json, compress_ranges, cut_dir, frame_count, load_config  # noqa: E402
from manifest import ManifestError, describe, update  # noqa: E402

DEFAULT_MAX_CHUNK = 180


def chunks(frames, cfg: dict):
    """Contiguous runs of `frames`, split at shot boundaries and at max_chunk. Returns [(first, last, shot)]."""
    shots = cfg.get("shots") or [["(all)", cfg["frame_start"], cfg["frame_end"]]]
    limit = cfg.get("max_chunk", DEFAULT_MAX_CHUNK)

    def shot_of(n):
        return next((s[0] for s in shots if s[1] <= n <= s[2]), "(no shot)")
    out = []
    for n in sorted(set(frames)):
        if out and n == out[-1][1] + 1 and shot_of(n) == out[-1][2] and n - out[-1][0] < limit:
            out[-1][1] = n
        else:
            out.append([n, n, shot_of(n)])
    return [tuple(c) for c in out]


def to_move(rep, cfg: dict):
    """Files on disk that block a clean re-render or assembly: [(path, reason)]."""
    std = lambda n: f"{cfg['frame_prefix']}{n:04d}.png".lower()   # noqa: E731
    moves = {}
    for i in rep.errors:
        if i.code == "extra":
            moves[i.path] = "outside the frame range"
    for n, f in rep.frames.items():
        codes = [c for c in f.codes if c != "duplicate_number"]
        if codes:
            moves[f.path] = ",".join(codes)
    for i in rep.errors:
        if i.code == "duplicate_number":
            folder = Path(rep.frames[i.frame].path).parent
            for name in i.detail.split(", "):
                if name.lower() != std(i.frame):
                    moves[str(folder / name)] = "duplicate frame number"
    return sorted(moves.items())


def quarantine(cfg: dict, root, moves, now=None) -> Path:
    dest = cut_dir(cfg, root) / "logs" / f"rejected_{time.strftime('%Y%m%d_%H%M%S', time.localtime(now))}"
    dest.mkdir(parents=True, exist_ok=False)
    record = []
    for src, why in moves:
        target = dest / Path(src).name
        shutil.move(src, target)                           # move, never delete
        record.append({"from": src, "to": str(target), "reason": why})
    atomic_write_json(dest / "moved.json", record)
    return dest


def chunk_snippet(cfg: dict, first: int, last: int) -> str:
    scene = cfg.get("scene") or "<scene name>"
    tail = f"episodes/{cfg['cut']}/frames/{cfg['frame_prefix']}"
    return f'''import bpy, os
sc = bpy.data.scenes[{scene!r}]; r = sc.render; wm = bpy.context.window_manager
assert not bpy.app.is_job_running("RENDER"), "a render is still running: wait for it, do not fire another chunk"
assert (r.resolution_x * r.resolution_percentage // 100, r.resolution_y * r.resolution_percentage // 100) == ({cfg["width"]}, {cfg["height"]}), "render size"
assert (r.fps, r.fps_base) == ({cfg["fps"]}, 1.0), "frame rate"
assert r.use_overwrite is False and r.use_placeholder is False, "use_overwrite/use_placeholder must be off"
assert os.path.normpath(bpy.path.abspath(r.filepath).rstrip("#")).lower().endswith(os.path.normpath({tail!r}).lower()), "output folder"
_old = (sc.frame_start, sc.frame_end)
def _restore(*_):
    sc.frame_start, sc.frame_end = _old
    for h in (bpy.app.handlers.render_complete, bpy.app.handlers.render_cancel):
        if _restore in h: h.remove(_restore)
bpy.app.handlers.render_complete.append(_restore); bpy.app.handlers.render_cancel.append(_restore)
sc.frame_start, sc.frame_end = {first}, {last}
with bpy.context.temp_override(window=wm.windows[0], scene=sc):
    bpy.ops.render.render("INVOKE_DEFAULT", animation=True)
print("[chunk] started {first}-{last}")'''


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--config", required=True)
    ap.add_argument("--root", default=str(ROOT))
    ap.add_argument("--quarantine", action="store_true", help="move blocking bad frames to logs/rejected_<time>/")
    ap.add_argument("--force", action="store_true", help="allow --quarantine to move more than half the sequence")
    ap.add_argument("--snippets", choices=("next", "all", "none"), default="next")
    args = ap.parse_args(argv)
    try:
        cfg = load_config(args.config)
        m, rep = update(cfg, args.root)
    except (ConfigError, ManifestError) as e:
        print(f"[resume] {e}", file=sys.stderr)
        return 2

    moves = to_move(rep, cfg)
    if moves and args.quarantine:
        if len(moves) > frame_count(cfg) // 2 and not args.force:
            print(f"[resume] refusing to move {len(moves)} files (more than half the sequence). If these frames are "
                  "good and only predate the manifest, run `manifest.py start --replace --adopt` instead; otherwise pass --force.",
                  file=sys.stderr)
            return 2
        dest = quarantine(cfg, args.root, moves)
        print(f"[resume] moved {len(moves)} file(s) to {dest} (see moved.json)")
        m, rep = update(cfg, args.root)
        moves = to_move(rep, cfg)

    print(describe(m))
    if moves:
        print(f"[resume] {len(moves)} bad file(s) on disk block a re-render (use_overwrite=False skips them):")
        for src, why in moves[:20]:
            print(f"    {Path(src).name:22} {why}")
        if len(moves) > 20:
            print(f"    ... and {len(moves) - 20} more")
        print("  Move them aside first:  python tools/pipeline/resume.py --config <cfg> --quarantine")

    todo = sorted(set(m["missing"]) | {n for n, f in rep.frames.items() if f.codes})
    if not todo and not moves:
        print("[resume] sequence complete. Next: python tools/pipeline/assemble_safe.py --config <cfg>")
        return 0
    plan = chunks(todo, cfg)
    print(f"[resume] {len(todo)} frame(s) to render in {len(plan)} chunk(s), one at a time:")
    for a, b, shot in plan:
        print(f"    {a}-{b:<5} ({b - a + 1:3} frames)  {shot}")
    if cfg.get("picture_lock") == "applied":
        print("[resume] picture lock is already applied in this cut's scene: load "
              f"{cfg.get('blend', 'the render-prep checkpoint')} and do NOT run tools/final/picture_lock.py.")
    print("[resume] Restart Blender before a long render. After each chunk finishes: "
          "python tools/pipeline/manifest.py update --config <cfg>")
    if args.snippets != "none" and plan:
        for a, b, shot in plan if args.snippets == "all" else plan[:1]:
            print(f"\n# ---- chunk {a}-{b} ({shot}): paste into the open Blender session via MCP\n"
                  + chunk_snippet(cfg, a, b))
    return 1


if __name__ == "__main__":
    sys.exit(main())
