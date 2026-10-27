"""
WhatIfStudio pipeline - verify a finished MP4 against its cut config (the CLAUDE.md export checklist, automated).

    python tools/pipeline/verify_mp4.py --config configs/ai_disappeared_final_30fps.json --mp4 episodes\\...\\x.mp4

Checks: one H.264 video stream, yuv420p, width x height, frame rate, decoded frame count = expected, duration =
frames / fps (within one frame), audio stream present / absent as the config's `audio` says (and, when present, not
shorter than the picture), and a full decode with no errors. Read-only.
Exit 0 = pass, 1 = fail, 2 = bad config / ffprobe missing.
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from dataclasses import asdict
from fractions import Fraction
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import ConfigError, Issue, ToolError, find_tool, frame_count, load_config  # noqa: E402


def probe(mp4, ffprobe: str) -> dict:
    r = subprocess.run([ffprobe, "-v", "error", "-count_frames", "-show_streams", "-show_format", "-of", "json",
                        str(mp4)], capture_output=True, text=True)
    if r.returncode != 0:
        raise ToolError(r.stderr.strip() or f"ffprobe exit {r.returncode}")
    return json.loads(r.stdout)


def decode_errors(mp4, ffmpeg: str) -> str:
    """Full decode to nowhere; returns ffmpeg's error output ('' = clean)."""
    r = subprocess.run([ffmpeg, "-hide_banner", "-nostdin", "-v", "error", "-i", str(mp4), "-f", "null", "-"],
                       capture_output=True, text=True)
    return (r.stderr.strip() or (f"ffmpeg exit {r.returncode}" if r.returncode else ""))


def _rate(s: str | None) -> Fraction | None:
    try:
        return Fraction(s) if s and s != "0/0" else None
    except (ValueError, ZeroDivisionError):
        return None


def verify(cfg: dict, mp4, ffprobe: str, ffmpeg: str | None = None, expected_frames: int | None = None) -> dict:
    """Returns a report dict with 'ok', 'issues' and the measured properties."""
    mp4 = Path(mp4)
    n_exp = expected_frames if expected_frames is not None else frame_count(cfg)
    fps = Fraction(cfg["fps"])
    issues, props = [], {}
    err = issues.append
    rep = {"file": str(mp4), "expected": {"frames": n_exp, "fps": cfg["fps"], "width": cfg["width"],
                                          "height": cfg["height"], "audio": cfg["audio"],
                                          "duration_s": round(float(n_exp / fps), 3)}, "measured": props}
    if not mp4.is_file() or mp4.stat().st_size == 0:
        err(Issue("missing_file", "error", path=str(mp4)))
    else:
        try:
            info = probe(mp4, ffprobe)
        except (ToolError, json.JSONDecodeError) as e:
            err(Issue("probe_failed", "error", path=str(mp4), detail=str(e)[:500]))
            info = None
        if info is not None:
            _check(cfg, info, n_exp, fps, props, err)
            if ffmpeg:
                d = decode_errors(mp4, ffmpeg)
                props["decode_clean"] = not d
                if d:
                    err(Issue("decode_errors", "error", detail=d[:500]))
    rep["issues"] = [asdict(i) for i in issues]
    rep["ok"] = not any(i.severity == "error" for i in issues)
    return rep


def _check(cfg, info, n_exp, fps, props, err):
    streams = info.get("streams", [])
    vids = [s for s in streams if s.get("codec_type") == "video"]
    auds = [s for s in streams if s.get("codec_type") == "audio"]
    props["video_streams"], props["audio_streams"] = len(vids), len(auds)
    if len(vids) != 1:
        err(Issue("video_streams", "error", detail=f"{len(vids)} video streams, expected 1"))
        if not vids:
            return
    v = vids[0]
    props.update(codec=v.get("codec_name"), pix_fmt=v.get("pix_fmt"), width=v.get("width"), height=v.get("height"),
                 r_frame_rate=v.get("r_frame_rate"), avg_frame_rate=v.get("avg_frame_rate"))
    if v.get("codec_name") != "h264":
        err(Issue("codec", "error", detail=f"{v.get('codec_name')}, expected h264"))
    if v.get("pix_fmt") != "yuv420p":
        err(Issue("pix_fmt", "error", detail=f"{v.get('pix_fmt')}, expected yuv420p"))
    if (v.get("width"), v.get("height")) != (cfg["width"], cfg["height"]):
        err(Issue("resolution", "error", detail=f"{v.get('width')}x{v.get('height')}, "
                                                f"expected {cfg['width']}x{cfg['height']}"))
    for key in ("r_frame_rate", "avg_frame_rate"):
        r = _rate(v.get(key))
        if r is not None and r != fps:
            err(Issue("frame_rate", "error", detail=f"{key} {v.get(key)} = {float(r):.3f}, expected {cfg['fps']}"))
    try:
        n = int(v.get("nb_read_frames"))
    except (TypeError, ValueError):
        n = None
    props["frames"] = n
    if n != n_exp:
        err(Issue("frame_count", "error", detail=f"{n} decoded frames, expected {n_exp}"))
    dur = v.get("duration") or info.get("format", {}).get("duration")
    try:
        dur = float(dur)
    except (TypeError, ValueError):
        dur = None
    props["duration_s"] = round(dur, 3) if dur is not None else None
    want = float(n_exp / fps)
    if dur is None or abs(dur - want) > 1.0 / float(fps) + 1e-3:
        err(Issue("duration", "error", detail=f"{dur} s, expected {want:.3f} s (+/- one frame)"))
    mode = cfg["audio"]
    if mode == "forbidden" and auds:
        err(Issue("audio_present", "error", detail="audio stream found but this cut is silent (audio: forbidden)"))
    if mode == "required" and not auds:
        err(Issue("audio_missing", "error", detail="no audio stream but this cut requires audio"))
    if auds:
        try:
            adur = float(auds[0].get("duration"))
        except (TypeError, ValueError):
            adur = None
        props["audio_duration_s"] = round(adur, 3) if adur is not None else None
        if adur is not None and adur < want - 1.0 / float(fps) - 0.05:
            err(Issue("audio_short", "error", detail=f"audio {adur:.3f} s is shorter than picture {want:.3f} s"))


def summarize(rep: dict) -> str:
    m, e = rep["measured"], rep["expected"]
    lines = [f"[verify] {rep['file']}",
             f"  expected {e['width']}x{e['height']} {e['fps']} fps {e['frames']} frames {e['duration_s']} s "
             f"audio:{e['audio']}",
             f"  measured {m.get('width')}x{m.get('height')} {m.get('r_frame_rate')} {m.get('frames')} frames "
             f"{m.get('duration_s')} s {m.get('codec')} {m.get('pix_fmt')} audio streams:{m.get('audio_streams')} "
             f"decode clean:{m.get('decode_clean')}"]
    lines += [f"  ERROR {i['code']}: {i['detail'] or i['path']}" for i in rep["issues"]]
    lines.append("[verify] OK" if rep["ok"] else "[verify] FAILED")
    return "\n".join(lines)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--config", required=True)
    ap.add_argument("--mp4", required=True)
    ap.add_argument("--json", help="write the report here (default: <mp4>.verify.json)")
    ap.add_argument("--no-decode", action="store_true", help="skip the full decode (faster)")
    args = ap.parse_args(argv)
    try:
        cfg = load_config(args.config)
        ffprobe = find_tool("ffprobe", cfg)
        ffmpeg = None if args.no_decode else find_tool("ffmpeg", cfg)
    except (ConfigError, ToolError) as e:
        print(f"[verify] {e}", file=sys.stderr)
        return 2
    rep = verify(cfg, args.mp4, ffprobe, ffmpeg)
    print(summarize(rep))
    out = Path(args.json) if args.json else Path(args.mp4).with_name(Path(args.mp4).name + ".verify.json")
    if out.parent.is_dir():
        out.write_text(json.dumps(rep, indent=2), encoding="utf-8")
    return 0 if rep["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
