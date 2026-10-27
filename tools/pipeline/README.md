# tools/pipeline: render manifest and frame validation

Plain Python (3.9+) and Pillow. Runs in a normal terminal, not inside Blender. These tools only **read** frames;
they never move, delete or overwrite them, and never render.

Each cut has a config in `configs/<cut>.json` (frame range, fps, size, `audio`: `forbidden` | `required` | `optional`).

```bat
REM before the first render chunk of a new cut
python tools\pipeline\manifest.py start  --config configs\ai_disappeared_final_30fps.json
REM a cut whose frames already exist: trust them as this render
python tools\pipeline\manifest.py start  --config configs\ai_disappeared_final_30fps.json --adopt
REM after every chunk (and after a crash): what is done, missing or bad
python tools\pipeline\manifest.py update --config configs\ai_disappeared_final_30fps.json
REM stand-alone check, e.g. right before encoding
python tools\pipeline\validate_frames.py --config configs\ai_disappeared_final_30fps.json
```

`episodes/<cut>/logs/manifest.json` (git-ignored) records the render id, config hash and, per frame, size,
dimensions, sha1, mtime and status. Frames written before `manifest.py start` count as **stale** (left over from an
earlier render) unless you used `--adopt`. If the render settings in the config change, `start` refuses; render into a
new cut folder, or use `start --replace` (the old manifest is archived and the old frames show as stale).

Errors (exit 1): missing, extra, duplicate-number, empty, unreadable, non-PNG, wrong size or colour mode, black
(outside `dark_ranges`), undersized, stale. Warnings: stray files, non-4-digit names, identical consecutive frames.
Exit 2 = bad config or manifest. Full check of 615 frames at 720x1280 takes about 15-20 s.

Tests: `python -m pytest` from the repo root.
