import json

import pytest

import assemble_safe
from assemble_safe import FrameChanged, Refused, assemble, free_name, read_checked
from common import validate_config
from conftest import decoded_means, make_wav
from manifest import start


def colour_frames(c):
    """Flat frames with a distinct, rising red level so the order can be read back from the MP4."""
    for n in range(c.cfg["frame_start"], c.cfg["frame_end"] + 1):
        c.frame(n, flat=(20 + n * 20, 90, 90))


@pytest.fixture
def ready(cut, tools):
    start(cut.cfg, cut.root)
    colour_frames(cut)
    return cut


def run(c, tools, **kw):
    ffmpeg, ffprobe = tools
    return assemble(kw.pop("cfg", c.cfg), c.root, ffmpeg=ffmpeg, ffprobe=ffprobe, log=lambda *_: None, **kw)


def outputs(c):
    d = c.root / "episodes" / "test_cut" / "output"
    return sorted(p.name for p in d.iterdir()) if d.exists() else []


def test_happy_path_order_and_verification(ready, tools):
    rep = run(ready, tools)
    assert rep["ok"] and rep["measured"]["frames"] == 10
    assert outputs(ready) == ["test_cut_9x16.mp4", "test_cut_9x16.mp4.verify.json"]
    reds = decoded_means(rep["output"])
    assert len(reds) == 10 and reds == sorted(reds) and reds[-1] - reds[0] > 100


def test_gap_refuses_and_writes_nothing(ready, tools):
    """Regression for the old assemble_video.py: a gap used to produce a short MP4 that still 'validated OK'."""
    ready.path(5).unlink()
    with pytest.raises(Refused, match="missing"):
        run(ready, tools)
    assert outputs(ready) == []


@pytest.mark.parametrize("damage", ["wrong_size", "black", "duplicate", "extra"])
def test_bad_frames_refuse(ready, tools, damage):
    if damage == "wrong_size":
        ready.frame(3, size=(18, 32), flat=(200, 90, 90))
    elif damage == "black":
        ready.frame(3, flat=(0, 0, 0))
    elif damage == "duplicate":
        ready.frame(3, digits=5, flat=(200, 90, 90))
    else:
        ready.frame(11, flat=(200, 90, 90))
    with pytest.raises(Refused):
        run(ready, tools)
    assert outputs(ready) == []


def test_never_overwrites_existing_mp4(ready, tools):
    first = run(ready, tools)["output"]
    before = open(first, "rb").read()
    second = run(ready, tools)["output"]
    assert second.endswith("test_cut_9x16_v2.mp4") and open(first, "rb").read() == before


def test_requires_manifest_unless_told(cut, tools):
    colour_frames(cut)
    with pytest.raises(Refused, match="no render manifest"):
        run(cut, tools)
    assert run(cut, tools, use_manifest=False)["ok"]


def test_manifest_for_other_settings_refuses(ready, tools):
    with pytest.raises(Refused, match="different render settings"):
        run(ready, tools, cfg=validate_config({**ready.cfg, "samples": 64}), use_manifest=True)


def test_stale_frames_refuse(cut, tools):
    import os
    import time
    colour_frames(cut)
    t = time.time() - 600
    for p in cut.frames.iterdir():
        os.utime(p, (t, t))
    start(cut.cfg, cut.root)                     # new render started after these frames were written
    with pytest.raises(Refused, match="stale"):
        run(cut, tools)


def test_audio_forbidden_refuses_audio(ready, tools, tmp_path):
    with pytest.raises(Refused, match="silent"):
        run(ready, tools, audio=make_wav(tmp_path / "vo.wav"))


def test_audio_required(make_cut, tools, tmp_path):
    c = make_cut(audio="required")
    start(c.cfg, c.root)
    colour_frames(c)
    with pytest.raises(Refused, match="requires audio"):
        run(c, tools)
    rep = run(c, tools, audio=make_wav(tmp_path / "vo.wav", seconds=2.0))   # longer than the picture: trimmed
    assert rep["ok"] and rep["measured"]["audio_streams"] == 1 and rep["measured"]["frames"] == 10


def test_audio_too_short_fails_verification(make_cut, tools, tmp_path):
    c = make_cut(audio="required", frame_end=60)
    start(c.cfg, c.root)
    colour_frames(c)
    with pytest.raises(Refused, match="audio_short"):
        run(c, tools, audio=make_wav(tmp_path / "vo.wav", seconds=0.5))
    assert outputs(c) == []


def test_failed_verification_publishes_nothing(ready, tools, monkeypatch):
    monkeypatch.setattr(assemble_safe, "verify", lambda *a, **k: {
        "ok": False, "file": "x", "issues": [{"code": "frame_count", "detail": "fake", "path": None}],
        "expected": {"width": 0, "height": 0, "fps": 0, "frames": 0, "duration_s": 0, "audio": "forbidden"},
        "measured": {}})
    with pytest.raises(Refused, match="not published"):
        run(ready, tools)
    assert outputs(ready) == []
    assert list((ready.root / "episodes" / "test_cut" / "logs").glob("verify_*.json"))


def test_frame_changed_after_validation_aborts(ready, tools, monkeypatch):
    real = assemble_safe.read_checked
    calls = []

    def tamper(path, sha1):
        calls.append(path)
        if len(calls) == 4:
            ready.frame(7, flat=(255, 0, 0))          # someone re-renders frame 7 mid-encode
        return real(path, sha1)
    monkeypatch.setattr(assemble_safe, "read_checked", tamper)
    with pytest.raises(FrameChanged):
        run(ready, tools)
    assert outputs(ready) == []


def test_read_checked(tmp_path):
    p = tmp_path / "f"
    p.write_bytes(b"abc")
    assert read_checked(p, "a9993e364706816aba3e25717850c26c9cd0d89d") == b"abc"
    with pytest.raises(FrameChanged):
        read_checked(p, "0" * 40)


def test_free_name(tmp_path):
    p = tmp_path / "x.mp4"
    assert free_name(p) == p
    p.write_bytes(b"")
    (tmp_path / "x_v2.mp4").write_bytes(b"")
    assert free_name(p).name == "x_v3.mp4"


def test_cli_dry_run_and_refusal(ready, tools, tmp_path, capsys):
    cfg = tmp_path / "c.json"
    cfg.write_text(json.dumps(ready.cfg))
    base = ["--config", str(cfg), "--root", str(ready.root)]
    assert assemble_safe.main(base + ["--dry-run"]) == 0
    assert "image2pipe" in capsys.readouterr().out and outputs(ready) == []
    ready.path(2).unlink()
    assert assemble_safe.main(base) == 1
    assert assemble_safe.main(base + ["--dry-run"]) == 1
