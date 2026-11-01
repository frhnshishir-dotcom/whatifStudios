import json
import subprocess

from PIL import Image

from conftest import FFMPEG, make_mp4
from reel_check import ZONES, check, main, moov_first

HD = (720, 1280)


def codes(rep, sev=None):
    return sorted(i["code"] for i in rep["issues"] if sev is None or i["severity"] == sev)


def test_good_reel_passes_and_writes_stills(tools, tmp_path):
    ffmpeg, ffprobe = tools
    mp4 = make_mp4(tmp_path / "r.mp4", frames=30, size=HD, audio_s=1.0)
    rep = check(mp4, ffmpeg, ffprobe, tmp_path / "pub", stills=3)
    assert rep["ok"], rep["issues"]
    assert "resolution" in codes(rep, "warning")          # 720p: works, 1080p recommended
    assert "no_audio" not in codes(rep)
    out = tmp_path / "pub"
    assert sorted(p.name for p in out.iterdir()) == ["cover_01.jpg", "cover_02.jpg", "cover_03.jpg", "report.json",
                                                     "safezone_01.png", "safezone_02.png", "safezone_03.png"]
    assert Image.open(out / "cover_01.jpg").size == (1080, 1920)
    assert json.loads((out / "report.json").read_text())["ok"] is True


def test_never_overwrites_output_folder(tools, tmp_path):
    ffmpeg, ffprobe = tools
    mp4 = make_mp4(tmp_path / "r.mp4", frames=10, size=HD, audio_s=0.5)
    check(mp4, ffmpeg, ffprobe, tmp_path / "pub", stills=1)
    rep = check(mp4, ffmpeg, ffprobe, tmp_path / "pub", stills=1)
    assert rep["measured"]["out_dir"].endswith("pub_v2")


def test_silent_render_is_not_ready(tools, tmp_path):
    ffmpeg, ffprobe = tools
    rep = check(make_mp4(tmp_path / "r.mp4", size=HD), ffmpeg, ffprobe)
    assert not rep["ok"] and "no_audio" in codes(rep, "error")


def test_wrong_shape_and_size(tools, tmp_path):
    ffmpeg, ffprobe = tools
    rep = check(make_mp4(tmp_path / "a.mp4", size=(36, 64), audio_s=0.4), ffmpeg, ffprobe)
    assert "resolution" in codes(rep, "error")
    rep = check(make_mp4(tmp_path / "b.mp4", size=(720, 720), audio_s=0.4), ffmpeg, ffprobe)
    assert "aspect" in codes(rep, "error")


def test_quiet_audio_warns(tools, tmp_path):
    ffmpeg, ffprobe = tools
    v = make_mp4(tmp_path / "v.mp4", frames=30, size=HD)
    q = tmp_path / "q.mp4"
    subprocess.run([FFMPEG, "-v", "error", "-y", "-i", str(v), "-f", "lavfi", "-t", "1", "-i",
                    "sine=frequency=440:sample_rate=48000", "-map", "0:v", "-map", "1:a", "-c:v", "copy",
                    "-af", "volume=-40dB", "-c:a", "aac", str(q)], check=True)
    rep = check(q, ffmpeg, ffprobe)
    assert "loudness" in codes(rep, "warning") and rep["ok"]


def test_moov_order(tools, tmp_path):
    v = make_mp4(tmp_path / "v.mp4", size=HD)
    fs = tmp_path / "fs.mp4"
    subprocess.run([FFMPEG, "-v", "error", "-y", "-i", str(v), "-c", "copy", "-movflags", "+faststart", str(fs)],
                   check=True)
    assert moov_first(v) is False and moov_first(fs) is True


def test_zones_and_cli(tools, tmp_path):
    assert ZONES == {"top": 0.08, "bottom": 0.20, "right": 0.15}
    assert main(["--mp4", str(make_mp4(tmp_path / "r.mp4", size=HD)), "--no-stills"]) == 1   # no audio
    assert main(["--mp4", str(tmp_path / "missing.mp4")]) == 2
