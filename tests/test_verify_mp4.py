import pytest

from common import validate_config
from conftest import make_mp4
from verify_mp4 import main, verify

CFG = validate_config({"cut": "c", "frame_start": 1, "frame_end": 10, "fps": 30, "width": 36, "height": 64,
                       "audio": "forbidden"})


def run(tools, path, **cfg_over):
    ffmpeg, ffprobe = tools
    return verify(validate_config({**CFG, **cfg_over}), path, ffprobe, ffmpeg)


def codes(rep):
    return sorted(i["code"] for i in rep["issues"])


def test_good_clip_passes(tools, tmp_path):
    rep = run(tools, make_mp4(tmp_path / "ok.mp4"))
    assert rep["ok"], rep["issues"]
    m = rep["measured"]
    assert (m["width"], m["height"], m["frames"], m["codec"], m["pix_fmt"]) == (36, 64, 10, "h264", "yuv420p")
    assert m["decode_clean"] is True and m["audio_streams"] == 0


def test_wrong_fps(tools, tmp_path):
    assert "frame_rate" in codes(run(tools, make_mp4(tmp_path / "a.mp4", fps=24)))


def test_wrong_resolution(tools, tmp_path):
    assert codes(run(tools, make_mp4(tmp_path / "a.mp4", size=(72, 128)))) == ["resolution"]


def test_short_clip(tools, tmp_path):
    assert codes(run(tools, make_mp4(tmp_path / "a.mp4", frames=9))) == ["frame_count"]   # duration within 1 frame
    assert codes(run(tools, make_mp4(tmp_path / "b.mp4", frames=5))) == ["duration", "frame_count"]


def test_wrong_pixel_format(tools, tmp_path):
    assert codes(run(tools, make_mp4(tmp_path / "a.mp4", pix_fmt="yuv444p"))) == ["pix_fmt"]


def test_wrong_codec(tools, tmp_path):
    assert "codec" in codes(run(tools, make_mp4(tmp_path / "a.mp4", codec="mpeg4")))


def test_audio_forbidden(tools, tmp_path):
    assert codes(run(tools, make_mp4(tmp_path / "a.mp4", audio_s=1))) == ["audio_present"]


def test_audio_required(tools, tmp_path):
    assert codes(run(tools, make_mp4(tmp_path / "a.mp4"), audio="required")) == ["audio_missing"]
    assert run(tools, make_mp4(tmp_path / "b.mp4", audio_s=1), audio="required")["ok"]


def test_audio_shorter_than_picture(tools, tmp_path):
    p = make_mp4(tmp_path / "a.mp4", frames=60, audio_s=0.5)
    assert "audio_short" in codes(run(tools, p, frame_end=60, audio="optional"))


def test_audio_optional_either_way(tools, tmp_path):
    assert run(tools, make_mp4(tmp_path / "a.mp4"), audio="optional")["ok"]
    assert run(tools, make_mp4(tmp_path / "b.mp4", audio_s=1), audio="optional")["ok"]


def test_corrupted_file(tools, tmp_path):
    p = make_mp4(tmp_path / "a.mp4", frames=60)
    data = bytearray(p.read_bytes())
    mid = len(data) // 2
    data[mid:mid + 2000] = bytes(2000)
    p.write_bytes(bytes(data))
    rep = run(tools, p, frame_end=60)
    assert not rep["ok"]


def test_missing_and_garbage_file(tools, tmp_path):
    assert codes(run(tools, tmp_path / "nope.mp4")) == ["missing_file"]
    g = tmp_path / "g.mp4"
    g.write_text("not a video")
    assert codes(run(tools, g)) == ["probe_failed"]


def test_cli(tools, tmp_path):
    import json
    cfg = tmp_path / "c.json"
    cfg.write_text(json.dumps(CFG))
    good = make_mp4(tmp_path / "ok.mp4")
    assert main(["--config", str(cfg), "--mp4", str(good)]) == 0
    assert json.loads((tmp_path / "ok.mp4.verify.json").read_text())["ok"] is True
    assert main(["--config", str(cfg), "--mp4", str(make_mp4(tmp_path / "bad.mp4", fps=24))]) == 1
    cfg.write_text("{}")
    assert main(["--config", str(cfg), "--mp4", str(good)]) == 2
