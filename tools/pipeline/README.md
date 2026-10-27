# tools/pipeline: checks for rendering, recovery and assembly

Plain Python (3.9+) and Pillow, run in a normal terminal (not inside Blender) unless marked **in Blender**.
None of these render, save a .blend, or delete a frame or video.

Each cut has a config in `configs/<cut>.json`: frame range, fps, size, samples, scene, .blend, shots,
`picture_lock` state, and `audio`: `forbidden` | `required` | `optional`. Optional `ffmpeg_dir` points at the ffmpeg
`bin` folder when a shell doesn't see the PATH change.

| Step | Command | What it does |
|---|---|---|
| 1 | **in Blender** `run("pipeline\\blender_snapshot.py", {"config": "configs/<cut>.json"})` | Read-only dump of the scene's render settings, markers and camera keys to `logs/blender_snapshot.json` |
| 2 | `python tools\pipeline\preflight.py --config configs\<cut>.json` | Python, Pillow, ffmpeg/ffprobe/libx264, scripts, .blend (not an LFS pointer), folders, disk space, manifest, snapshot vs config, picture-lock state |
| 3 | `python tools\pipeline\manifest.py start --config ...` | Start the render record (`--adopt` for good frames that already exist) |
| 4 | `python tools\pipeline\resume.py --config ...` | After each chunk or a crash: what's done, what's missing/bad, and a guarded MCP snippet for the next chunk |
| 4b | `python tools\pipeline\resume.py --config ... --quarantine` | Move bad frames (black, wrong size, stale, out of range, duplicate names) to `logs/rejected_<time>/` so Blender re-renders them |
| 5 | `python tools\pipeline\assemble_safe.py --config ...` | Refuses unless every frame is valid; encodes, verifies, then publishes. Never overwrites (writes `_v2`, ...) |
| 6 | `python tools\pipeline\verify_mp4.py --config ... --mp4 <file>` | Re-check any MP4: codec, yuv420p, size, fps, frame count, duration, audio per config, full decode |
| - | **in Blender** `run("pipeline\\guard_picture_lock.py", {"config": ...})` | Run before `tools/final/picture_lock.py`; raises unless the scene is still the pre-lock v6 layout |

`validate_frames.py --config ...` is the stand-alone frame check that steps 4 and 5 use.

## Render manifest
`episodes/<cut>/logs/manifest.json` (git-ignored) holds the render id, config hash, expected range, per-frame size,
dimensions, sha1, mtime and status, and a progress history. Frames written before `manifest.py start` count as
**stale** unless you used `--adopt`. If render settings in the config change (range, fps, size, samples, scene, .blend),
`start` refuses: render into a new cut folder, or use `start --replace` (old manifest archived, old frames stale).
Validation-only keys (`audio`, thresholds, shots, notes) can change freely.

Frame errors: missing, extra, duplicate number, empty, unreadable, non-PNG, wrong size or colour mode, black (outside
`dark_ranges`), undersized, stale. Warnings: stray files, non-4-digit names, identical consecutive frames.

## Exit codes
0 = OK / ready, 1 = problems found (or work remains, for resume), 2 = bad config, manifest or missing tool.

## Tests
`python -m pip install -r requirements-dev.txt` then `python -m pytest` from the repo root. The encode tests need
ffmpeg on PATH and are skipped without it. Blender is never needed; the in-Blender scripts are tested against a fake `bpy`.
