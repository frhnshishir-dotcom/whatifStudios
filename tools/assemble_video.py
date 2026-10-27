"""
WhatIfStudio - assemble frames (+ optional audio) into a 9:16 MP4 and validate it.

    python tools/assemble_video.py --episode ai_disappeared
Needs ffmpeg + ffprobe on PATH. Uses the first .wav/.mp3/.m4a in episodes/<ep>/audio/.
"""
import argparse, json, re, subprocess, sys
from pathlib import Path

ap = argparse.ArgumentParser()
ap.add_argument("--episode", default="ai_disappeared")
ap.add_argument("--fps", type=int, default=24)
ap.add_argument("--root", default=str(Path(__file__).resolve().parent.parent))
args = ap.parse_args()

ep = Path(args.root) / "episodes" / args.episode
frames = sorted((ep / "frames").glob("frame_*.png"))
if not frames:
    sys.exit(f"No frames in {ep / 'frames'} - render first (animate_episode.py --render).")
start = int(re.search(r"(\d+)", frames[0].stem).group(1))
audio = next((p for ext in ("*.wav", "*.mp3", "*.m4a") for p in sorted((ep / "audio").glob(ext))), None)
out = ep / "output" / f"{args.episode}_9x16.mp4"
out.parent.mkdir(parents=True, exist_ok=True)

cmd = ["ffmpeg", "-y", "-loglevel", "error", "-framerate", str(args.fps),
       "-start_number", str(start), "-i", str(ep / "frames" / "frame_%04d.png")]
if audio:
    cmd += ["-i", str(audio)]
cmd += ["-vf", "scale=720:1280:force_original_aspect_ratio=decrease,"
               "pad=720:1280:(ow-iw)/2:(oh-ih)/2,format=yuv420p",
        "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-movflags", "+faststart"]
if audio:
    cmd += ["-c:a", "aac", "-b:a", "192k", "-shortest"]
cmd.append(str(out))
print("[assemble]", len(frames), "frames", "+ audio: " + audio.name if audio else "(no audio)")
subprocess.run(cmd, check=True)

# ---------- validate ----------
probe = json.loads(subprocess.run(
    ["ffprobe", "-v", "error", "-show_streams", "-show_format", "-of", "json", str(out)],
    capture_output=True, text=True, check=True).stdout)
v = next(s for s in probe["streams"] if s["codec_type"] == "video")
a = next((s for s in probe["streams"] if s["codec_type"] == "audio"), None)
report = {
    "file": str(out),
    "resolution": f"{v['width']}x{v['height']}",
    "is_720x1280": (v["width"], v["height"]) == (720, 1280),
    "is_9x16": v["width"] * 16 == v["height"] * 9,
    "frames_in": len(frames),
    "duration_s": round(float(probe["format"]["duration"]), 2),
    "video_codec": v["codec_name"],
    "has_audio": a is not None,
}
print(json.dumps(report, indent=2))
problems = [k for k in ("is_720x1280", "is_9x16") if not report[k]]
if problems:
    print("[validate] WARNING:", ", ".join(problems))
else:
    print("[validate] OK" + ("" if report["has_audio"] else " (no audio - add narration/SFX in CapCut)"))
