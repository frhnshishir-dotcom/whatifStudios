"""
WhatIfStudio pipeline - pre-upload check for the reel you actually post (the CapCut export, with VO/music/SFX).

    python tools/pipeline/reel_check.py --mp4 "C:\\...\\EP001_capcut_export.mp4"
    python tools/pipeline/reel_check.py --mp4 x.mp4 --out episodes/ai_disappeared_long/publish --ffmpeg-dir C:\\...\\bin

verify_mp4.py checks the silent Blender render against its cut config. This checks the *final* file against what
Instagram Reels, TikTok and YouTube Shorts accept and reward:

  errors   (exit 1): not H.264/HEVC, not 9:16, smaller than 720x1280, fps outside 23.976-60, no audio track,
                     longer than 180 s (Reels/Shorts limit), decode errors
  warnings (exit 0): under 1080x1920, over 90 s, loudness far from -14 LUFS, true peak above -1 dBTP,
                     silent or black first half-second (weak hook), moov atom not at the front (slow upload start),
                     audio not AAC or not 44.1/48 kHz, pix_fmt not yuv420p

It also writes, into a NEW folder (never overwrites; adds _v2, _v3 ...):
  safezone_NN.png  stills with the zones the app UI covers shaded (top 8%, bottom 20%, right 15%):
                   open them and check no caption, clock or end-card text sits in red
  cover_NN.jpg     1080x1920 cover/thumbnail candidates (first frame + evenly spaced)
  report.json      everything measured
Read-only on the MP4. Exit 0 = ready to post (maybe with warnings), 1 = fix first, 2 = ffmpeg missing / unreadable.
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from dataclasses import asdict
from fractions import Fraction
from pathlib import Path

from PIL import Image, ImageDraw, ImageStat

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import Issue, ToolError, find_tool  # noqa: E402

# Unsafe zones as fractions of the frame (app UI: tabs on top; caption, username, buttons bottom; like/comment right).
ZONES = {"top": 0.08, "bottom": 0.20, "right": 0.15}
MAX_S, LONG_S = 180.0, 90.0
TARGET_LUFS, LUFS_TOL, MAX_TP = -14.0, 2.0, -1.0
HOOK_S = 0.5


def _run(cmd) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, capture_output=True, text=True, errors="replace")


def probe(mp4, ffprobe) -> dict:
    r = _run([ffprobe, "-v", "error", "-show_streams", "-show_format", "-of", "json", str(mp4)])
    if r.returncode != 0:
        raise ToolError(r.stderr.strip() or f"ffprobe exit {r.returncode}")
    return json.loads(r.stdout)


def loudness(mp4, ffmpeg) -> dict:
    """Integrated loudness (LUFS) and true peak (dBTP) from ffmpeg's ebur128 summary."""
    r = _run([ffmpeg, "-hide_banner", "-nostdin", "-i", str(mp4), "-map", "0:a:0", "-af", "ebur128=peak=true",
              "-f", "null", "-"])
    summary = r.stderr.rsplit("Summary:", 1)[-1]
    i = re.search(r"I:\s*(-?[\d.]+|-inf)\s*LUFS", summary)
    tp = re.search(r"True peak:\s*Peak:\s*(-?[\d.]+|-inf)\s*dBFS", summary)
    f = lambda m: (float(m.group(1)) if m and m.group(1) != "-inf" else None)  # noqa: E731
    return {"lufs": f(i), "true_peak_db": f(tp)}


def opening_silent(mp4, ffmpeg, seconds=HOOK_S) -> bool:
    """True if the first `seconds` of audio are all below -45 dB."""
    r = _run([ffmpeg, "-hide_banner", "-nostdin", "-t", str(seconds), "-i", str(mp4), "-map", "0:a:0",
              "-af", f"silencedetect=n=-45dB:d={seconds * 0.95}", "-f", "null", "-"])
    return "silence_start" in r.stderr


def grab(mp4, ffmpeg, t: float, dest: Path) -> Path:
    r = _run([ffmpeg, "-hide_banner", "-nostdin", "-v", "error", "-ss", f"{t:.3f}", "-i", str(mp4),
              "-frames:v", "1", "-y", str(dest)])
    if r.returncode != 0 or not dest.is_file():
        raise ToolError(f"could not extract frame at {t:.2f}s: {r.stderr.strip()}")
    return dest


def moov_first(mp4) -> bool | None:
    """Walk top-level MP4 boxes: True if moov comes before mdat (faststart). None if unparseable."""
    try:
        with open(mp4, "rb") as fh:
            while True:
                head = fh.read(8)
                if len(head) < 8:
                    return None
                size, kind = int.from_bytes(head[:4], "big"), head[4:8]
                if kind == b"moov":
                    return True
                if kind == b"mdat":
                    return False
                if size == 1:
                    size = int.from_bytes(fh.read(8), "big")
                    fh.seek(size - 16, 1)
                elif size < 8:
                    return None
                else:
                    fh.seek(size - 8, 1)
    except OSError:
        return None


def _rate(s):
    try:
        r = Fraction(s)
        return r if r > 0 else None
    except (TypeError, ValueError, ZeroDivisionError):
        return None


def shade_zones(src: Path, dest: Path) -> Path:
    im = Image.open(src).convert("RGB")
    w, h = im.size
    ov = Image.new("RGBA", im.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(ov)
    red = (255, 0, 0, 90)
    d.rectangle([0, 0, w, int(h * ZONES["top"])], fill=red)
    d.rectangle([0, int(h * (1 - ZONES["bottom"])), w, h], fill=red)
    d.rectangle([int(w * (1 - ZONES["right"])), int(h * ZONES["top"]), w, int(h * (1 - ZONES["bottom"]))], fill=red)
    lw = max(2, w // 360)
    d.rectangle([0, int(h * ZONES["top"]), int(w * (1 - ZONES["right"])), int(h * (1 - ZONES["bottom"]))],
                outline=(255, 230, 0, 255), width=lw)   # yellow = safe area for text
    Image.alpha_composite(im.convert("RGBA"), ov).convert("RGB").save(dest)
    return dest


def new_dir(base: Path) -> Path:
    out, n = base, 1
    while out.exists():
        n += 1
        out = base.with_name(f"{base.name}_v{n}")
    out.mkdir(parents=True)
    return out


def check(mp4, ffmpeg, ffprobe, out: Path | None = None, stills: int = 5) -> dict:
    mp4 = Path(mp4)
    info = probe(mp4, ffprobe)
    v = [s for s in info["streams"] if s.get("codec_type") == "video"]
    a = [s for s in info["streams"] if s.get("codec_type") == "audio"]
    issues: list[Issue] = []
    err = lambda c, d: issues.append(Issue(c, "error", detail=d))   # noqa: E731
    warn = lambda c, d: issues.append(Issue(c, "warning", detail=d))  # noqa: E731
    if not v:
        raise ToolError("no video stream")
    vs = v[0]
    w, h = int(vs.get("width", 0)), int(vs.get("height", 0))
    fps = _rate(vs.get("avg_frame_rate")) or _rate(vs.get("r_frame_rate"))
    dur = float(info["format"].get("duration") or vs.get("duration") or 0)
    m = {"file": str(mp4), "size_mb": round(mp4.stat().st_size / 1e6, 2), "codec": vs.get("codec_name"),
         "pix_fmt": vs.get("pix_fmt"), "width": w, "height": h, "fps": float(fps) if fps else None,
         "duration_s": round(dur, 3), "audio_streams": len(a)}

    if m["codec"] not in ("h264", "hevc"):
        err("codec", f"video codec {m['codec']}; export H.264 (or HEVC)")
    if m["pix_fmt"] != "yuv420p":
        warn("pix_fmt", f"pix_fmt {m['pix_fmt']}; yuv420p is the safe choice")
    if not h or abs(w / h - 9 / 16) > 0.01:
        err("aspect", f"{w}x{h} is not 9:16; the apps will crop or letterbox it")
    if w < 720 or h < 1280:
        err("resolution", f"{w}x{h} is below 720x1280")
    elif w < 1080 or h < 1920:
        warn("resolution", f"{w}x{h}; export 1080x1920 from CapCut for sharper playback")
    if not fps or not (23.9 <= float(fps) <= 60.01):
        err("frame_rate", f"frame rate {m['fps']} outside 24-60 fps")
    if dur > MAX_S:
        err("duration", f"{dur:.1f}s is over the {MAX_S:.0f}s Reels/Shorts limit")
    elif dur > LONG_S:
        warn("duration", f"{dur:.1f}s; reels over {LONG_S:.0f}s get fewer non-follower views")

    if not a:
        err("no_audio", "no audio track; add the VO/music in CapCut before posting")
    else:
        aus = a[0]
        m.update(audio_codec=aus.get("codec_name"), sample_rate=int(aus.get("sample_rate") or 0))
        if m["audio_codec"] != "aac":
            warn("audio_codec", f"audio {m['audio_codec']}; AAC is the safe choice")
        if m["sample_rate"] not in (44100, 48000):
            warn("sample_rate", f"audio at {m['sample_rate']} Hz; use 44.1 or 48 kHz")
        m.update(loudness(mp4, ffmpeg))
        if m["lufs"] is None or abs(m["lufs"] - TARGET_LUFS) > LUFS_TOL:
            warn("loudness", f"integrated loudness {m['lufs']} LUFS; aim for {TARGET_LUFS:.0f} +/- {LUFS_TOL:.0f} "
                             "(quieter reels sound weak next to others; louder ones get turned down)")
        if m["true_peak_db"] is not None and m["true_peak_db"] > MAX_TP:
            warn("true_peak", f"true peak {m['true_peak_db']} dBTP > {MAX_TP}; it may clip after re-encoding")
        m["opening_silent"] = opening_silent(mp4, ffmpeg)
        if m["opening_silent"]:
            warn("silent_hook", f"no sound in the first {HOOK_S}s; start the VO or a hit on frame 1")

    mf = moov_first(mp4)
    m["faststart"] = mf
    if mf is False:
        warn("faststart", "moov atom at the end (no faststart); fine for upload, slower to start streaming")

    r = _run([ffmpeg, "-hide_banner", "-nostdin", "-v", "error", "-i", str(mp4), "-f", "null", "-"])
    m["decode_clean"] = not (r.stderr.strip() or r.returncode)
    if not m["decode_clean"]:
        err("decode", (r.stderr.strip() or f"ffmpeg exit {r.returncode}")[:500])

    files = []
    if out is not None:
        out = new_dir(Path(out))
        times = [0.0] + [dur * (k + 1) / (stills + 1) for k in range(max(stills - 1, 0))]
        for k, t in enumerate(times, 1):
            raw = grab(mp4, ffmpeg, t, out / f"_raw_{k:02d}.png")
            im = Image.open(raw).convert("RGB")
            if k == 1:
                luma = ImageStat.Stat(im.convert("L")).mean[0]
                m["first_frame_luma"] = round(luma, 1)
                if luma < 12:
                    warn("dark_hook", "first frame is almost black; the first frame is the thumbnail in feeds")
            im.resize((1080, 1920), Image.LANCZOS).save(out / f"cover_{k:02d}.jpg", quality=92)
            shade_zones(raw, out / f"safezone_{k:02d}.png")
            raw.unlink()
            files += [f"cover_{k:02d}.jpg", f"safezone_{k:02d}.png"]
        m["out_dir"] = str(out)

    rep = {"ok": not any(i.severity == "error" for i in issues), "measured": m, "files": files,
           "issues": [asdict(i) for i in issues]}
    if out is not None:
        (out / "report.json").write_text(json.dumps(rep, indent=2), encoding="utf-8")
    return rep


def summarize(rep: dict) -> str:
    m = rep["measured"]
    lines = [f"{'READY' if rep['ok'] else 'FIX FIRST'}: {m['file']}",
             f"  {m['width']}x{m['height']} {m['codec']} {m['pix_fmt']} {m['fps']} fps {m['duration_s']} s "
             f"{m['size_mb']} MB, audio streams {m['audio_streams']}"
             + (f", {m.get('lufs')} LUFS, TP {m.get('true_peak_db')} dBTP" if m["audio_streams"] else "")]
    lines += [f"  [{i['severity']}] {i['code']}: {i['detail']}" for i in rep["issues"]]
    if m.get("out_dir"):
        lines.append(f"  stills: {m['out_dir']} (open safezone_*.png: no text in the red zones)")
    return "\n".join(lines)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--mp4", required=True)
    ap.add_argument("--out", help="folder for stills/covers/report (default: <mp4 folder>/publish_<mp4 name>)")
    ap.add_argument("--no-stills", action="store_true")
    ap.add_argument("--stills", type=int, default=5)
    ap.add_argument("--ffmpeg-dir")
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args(argv)
    mp4 = Path(a.mp4)
    if not mp4.is_file():
        print(f"not found: {mp4}", file=sys.stderr)
        return 2
    cfg = {"ffmpeg_dir": a.ffmpeg_dir} if a.ffmpeg_dir else None
    try:
        ffmpeg, ffprobe = find_tool("ffmpeg", cfg), find_tool("ffprobe", cfg)
        out = None if a.no_stills else Path(a.out or mp4.parent / f"publish_{mp4.stem}")
        rep = check(mp4, ffmpeg, ffprobe, out, a.stills)
    except ToolError as e:
        print(f"error: {e}", file=sys.stderr)
        return 2
    print(json.dumps(rep, indent=2) if a.json else summarize(rep))
    return 0 if rep["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
