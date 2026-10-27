"""
WhatIfStudio pipeline - safe MP4 assembly: validate frames, encode, verify, and only then publish the file.

    python tools/pipeline/assemble_safe.py --config configs/ai_disappeared_final_30fps.json
    python tools/pipeline/assemble_safe.py --config <cfg> --audio episodes\\<cut>\\audio\\mix.wav   # audio: required/optional
    python tools/pipeline/assemble_safe.py --config <cfg> --dry-run

Differences from tools/assemble_video.py (kept unchanged for reference):
- Refuses to encode unless validate_frames passes (no gaps, duplicates, extras, wrong sizes, black or stale frames)
  and the render manifest matches the config (or --no-manifest is given on purpose).
- Frames are fed to ffmpeg one by one in frame-number order from the validated list, re-checking each file's sha1,
  so a gap can never silently shorten the video and a frame changed after validation aborts the encode.
- fps and size come from the cut config. No scale/pad: a wrong-size frame is an error, not a letterbox.
- Audio is never picked up automatically. The cut's `audio` setting decides: forbidden / required / optional.
  The audio is cut to the picture length (no -shortest, which can cut the picture).
- Writes <name>.<id>.partial.mp4, verifies it (verify_mp4), then renames it. Never overwrites an existing MP4:
  if the name is taken, it writes <name>_v2.mp4, _v3, ...
Exit 0 = verified MP4 written, 1 = refused or verification failed, 2 = bad config / tool missing.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import sys
import time
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import (ROOT, ConfigError, ToolError, config_hash, cut_dir, find_tool, frame_count,  # noqa: E402
                    load_config)
from manifest import ManifestError, manifest_path, read_manifest  # noqa: E402
from validate_frames import summarize, validate  # noqa: E402
from verify_mp4 import summarize as summarize_mp4, verify  # noqa: E402


class Refused(RuntimeError):
    pass


class FrameChanged(RuntimeError):
    pass


def free_name(path: Path) -> Path:
    """path if unused, else path_v2, path_v3, ... (never an existing file)."""
    if not path.exists():
        return path
    k = 2
    while True:
        cand = path.with_name(f"{path.stem}_v{k}{path.suffix}")
        if not cand.exists():
            return cand
        k += 1


def read_checked(path, sha1: str) -> bytes:
    data = Path(path).read_bytes()
    if hashlib.sha1(data).hexdigest() != sha1:
        raise FrameChanged(f"{path} changed after validation; nothing was published")
    return data


def plan(cfg: dict, root=ROOT, frames_dir=None, audio=None, use_manifest=True, output=None):
    """All checks that happen before ffmpeg runs. Returns (frame list [(n, path, sha1)], audio path, output path)."""
    cdir = cut_dir(cfg, root)
    frames_dir = Path(frames_dir) if frames_dir else cdir / "frames"
    since = None
    if use_manifest:
        try:
            m = read_manifest(manifest_path(cfg, root))
        except ManifestError as e:
            raise Refused(str(e)) from e
        if m is None:
            raise Refused("no render manifest for this cut. Run `manifest.py start` before rendering "
                          "(or `start --adopt` for frames already on disk), or pass --no-manifest on purpose.")
        if m["config_hash"] != config_hash(cfg):
            raise Refused(f"manifest {m['render_id']} was made for different render settings; refusing to mix frames")
        since = m["started_at"]

    mode = cfg["audio"]
    audio = audio or (str(cdir / cfg["audio_file"]) if cfg.get("audio_file") else None)
    if mode == "forbidden" and audio:
        raise Refused(f"this cut is silent (audio: forbidden) but audio was given: {audio}")
    if mode == "required" and not audio:
        raise Refused("this cut requires audio (audio: required); pass --audio <file>")
    if audio and not Path(audio).is_file():
        raise Refused(f"audio file not found: {audio}")

    rep = validate(cfg, frames_dir, since=since)
    if not rep.ok:
        raise Refused("frame validation failed, not encoding:\n" + summarize(rep))
    frames = [(n, Path(rep.frames[n].path), rep.frames[n].sha1) for n in sorted(rep.frames)]
    expected = list(range(cfg["frame_start"], cfg["frame_end"] + 1))
    if [n for n, _, _ in frames] != expected:          # belt and braces: validate() already guarantees this
        raise Refused("frame list is not exactly the expected contiguous range")

    out = Path(output) if output else cdir / "output" / cfg.get("output_name", f"{cfg['cut']}_9x16.mp4")
    if out.suffix.lower() != ".mp4":
        raise Refused(f"output must be .mp4: {out}")
    return frames, (Path(audio) if audio else None), out


def ffmpeg_cmd(cfg: dict, ffmpeg: str, partial: Path, audio: Path | None) -> list:
    n = frame_count(cfg)
    cmd = [ffmpeg, "-hide_banner", "-v", "error", "-n",
           "-f", "image2pipe", "-framerate", str(cfg["fps"]), "-c:v", "png", "-i", "pipe:0"]
    if audio:
        cmd += ["-i", str(audio)]
    cmd += ["-map", "0:v:0"] + (["-map", "1:a:0"] if audio else [])
    # Exactly n frames are piped in, so no -frames:v (on ffmpeg 4.x it also ends the audio at the last video frame).
    cmd += ["-vf", "format=yuv420p", "-c:v", "libx264", "-profile:v", "high",
            "-preset", str(cfg.get("preset", "medium")), "-crf", str(cfg.get("crf", 18)),
            "-r", str(cfg["fps"]), "-movflags", "+faststart"]
    if audio:
        cmd += ["-c:a", "aac", "-b:a", "192k", "-t", f"{n / cfg['fps']:.6f}"]
    return cmd + [str(partial)]


def assemble(cfg: dict, root=ROOT, frames_dir=None, audio=None, use_manifest=True, output=None,
             ffmpeg=None, ffprobe=None, log=print) -> dict:
    """Validate, encode, verify, publish. Returns the verify report (with 'output'). Raises Refused on refusal."""
    ffmpeg = ffmpeg or find_tool("ffmpeg", cfg)
    ffprobe = ffprobe or find_tool("ffprobe", cfg)
    frames, audio, out = plan(cfg, root, frames_dir, audio, use_manifest, output)
    out.parent.mkdir(parents=True, exist_ok=True)
    logs = cut_dir(cfg, root) / "logs"
    logs.mkdir(parents=True, exist_ok=True)
    run_id = time.strftime("%Y%m%d_%H%M%S") + "_" + uuid.uuid4().hex[:6]
    partial = out.with_name(f"{out.stem}.{run_id}.partial.mp4")
    for old in out.parent.glob(f"{out.stem}.*.partial.mp4"):
        log(f"[assemble] note: leftover from an interrupted run (safe to delete): {old}")
    log(f"[assemble] {len(frames)} frames {frames[0][0]}-{frames[-1][0]} @ {cfg['fps']} fps, "
        f"{'audio: ' + audio.name if audio else 'silent'} -> {partial.name}")

    errlog = logs / f"assemble_{run_id}.log"
    cmd = ffmpeg_cmd(cfg, ffmpeg, partial, audio)
    try:
        with open(errlog, "w", encoding="utf-8") as ef:
            ef.write(" ".join(cmd) + "\n")
            ef.flush()
            proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=ef)
            try:
                for n, path, sha1 in frames:
                    proc.stdin.write(read_checked(path, sha1))
                proc.stdin.close()
            except BrokenPipeError:
                pass                                   # ffmpeg died; its exit code and log say why
            except BaseException:
                proc.kill()
                try:
                    proc.stdin.close()
                except OSError:
                    pass
                proc.wait()
                raise
            rc = proc.wait()
        if rc != 0:
            raise Refused(f"ffmpeg failed (exit {rc}); see {errlog}:\n{errlog.read_text(encoding='utf-8')[-1500:]}")
        rep = verify(cfg, partial, ffprobe, ffmpeg)
        if not rep["ok"]:
            (logs / f"verify_{run_id}.json").write_text(json.dumps(rep, indent=2), encoding="utf-8")
            raise Refused("encoded file failed verification, not published:\n" + summarize_mp4(rep))
        final = free_name(out)
        os.rename(partial, final)                      # final name was free a moment ago; rename never overwrites on Windows
        rep["file"] = str(final)
        rep["output"] = str(final)
        rep["run_id"] = run_id
        rep["frames_dir"] = str(frames[0][1].parent)
        final.with_name(final.name + ".verify.json").write_text(json.dumps(rep, indent=2), encoding="utf-8")
        log(summarize_mp4(rep))
        return rep
    finally:
        if partial.exists():
            partial.unlink()


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--config", required=True)
    ap.add_argument("--root", default=str(ROOT))
    ap.add_argument("--frames", help="frames folder (default episodes/<cut>/frames)")
    ap.add_argument("--audio", help="audio file to mux (only if the cut's audio setting allows it)")
    ap.add_argument("--output", help="output .mp4 (default episodes/<cut>/output/<output_name>)")
    ap.add_argument("--no-manifest", action="store_true", help="assemble without a render manifest (no stale check)")
    ap.add_argument("--dry-run", action="store_true", help="run every check, print the ffmpeg command, encode nothing")
    args = ap.parse_args(argv)
    try:
        cfg = load_config(args.config)
        if args.dry_run:
            frames, audio, out = plan(cfg, args.root, args.frames, args.audio, not args.no_manifest, args.output)
            print(f"[assemble] dry run OK: {len(frames)} frames, {'audio ' + str(audio) if audio else 'silent'}, "
                  f"would write {free_name(out)}")
            print(" ".join(ffmpeg_cmd(cfg, find_tool("ffmpeg", cfg), Path("<partial>.mp4"), audio)))
            return 0
        assemble(cfg, args.root, args.frames, args.audio, not args.no_manifest, args.output)
        return 0
    except (ConfigError, ToolError) as e:
        print(f"[assemble] {e}", file=sys.stderr)
        return 2
    except (Refused, FrameChanged) as e:
        print(f"[assemble] REFUSED: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
