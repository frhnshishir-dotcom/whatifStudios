import json
import os

import pytest

import common
from common import (ConfigError, atomic_write_json, compress_ranges, config_hash, load_config, scan_frames,
                    validate_config)

BASE = {"cut": "c", "frame_start": 1, "frame_end": 615, "fps": 30, "width": 720, "height": 1280, "audio": "forbidden"}


def test_valid_config_gets_defaults():
    cfg = validate_config(BASE)
    assert cfg["frame_prefix"] == "frame_" and cfg["color_mode"] == "RGB" and cfg["dark_ranges"] == []


@pytest.mark.parametrize("change", [
    {"cut": None}, {"fps": 0}, {"fps": 29.97}, {"fps": True}, {"width": 721}, {"height": -2},
    {"frame_end": 0}, {"frame_start": -1}, {"audio": "maybe"}, {"cut": "../x"},
    {"dark_ranges": [[5]]}, {"dark_ranges": [[9, 3]]},
])
def test_bad_config_rejected(change):
    data = {**BASE, **change}
    data = {k: v for k, v in data.items() if v is not None}
    with pytest.raises(ConfigError):
        validate_config(data)


def test_per_cut_audio_modes():
    for mode in ("forbidden", "required", "optional"):
        assert validate_config({**BASE, "audio": mode})["audio"] == mode


def test_repo_config_is_valid():
    cfg = load_config(common.ROOT / "configs" / "ai_disappeared_final_30fps.json")
    assert (cfg["frame_end"] - cfg["frame_start"] + 1, cfg["fps"]) == (615, 30)
    assert (cfg["width"], cfg["height"], cfg["audio"]) == (720, 1280, "forbidden")


def test_load_config_bad_json(tmp_path):
    p = tmp_path / "c.json"
    p.write_text("{not json", encoding="utf-8")
    with pytest.raises(ConfigError):
        load_config(p)


def test_config_hash_tracks_render_keys_only():
    h = config_hash(validate_config(BASE))
    assert config_hash(validate_config({**BASE, "black_threshold": 9.0, "audio": "optional", "notes": "x"})) == h
    assert config_hash(validate_config({**BASE, "fps": 24})) != h
    assert config_hash(validate_config({**BASE, "samples": 32})) != h


def test_scan_frames_duplicates_and_strays(tmp_path):
    for name in ("frame_0001.png", "frame_00001.png", "frame_0002.PNG", "frame_0003_old.png",
                 "frame_0004.png.tmp", "notes.txt", "Thumbs.db"):
        (tmp_path / name).write_bytes(b"x")
    frames, strays = scan_frames(tmp_path)
    assert sorted(frames) == [1, 2] and len(frames[1]) == 2
    assert sorted(p.name for p in strays) == ["frame_0003_old.png", "frame_0004.png.tmp", "notes.txt"]


def test_compress_ranges():
    assert compress_ranges([]) == ""
    assert compress_ranges([7, 1, 2, 3, 9, 10, 3]) == "1-3, 7, 9-10"


def test_atomic_write_replaces(tmp_path):
    p = tmp_path / "sub" / "m.json"
    atomic_write_json(p, {"a": 1})
    atomic_write_json(p, {"a": 2})
    assert json.loads(p.read_text()) == {"a": 2}
    assert [f.name for f in p.parent.iterdir()] == ["m.json"]


def test_atomic_write_crash_keeps_old_file(tmp_path, monkeypatch):
    p = tmp_path / "m.json"
    atomic_write_json(p, {"a": 1})

    def boom(*_):
        raise OSError("disk unplugged")
    monkeypatch.setattr(os, "replace", boom)
    with pytest.raises(OSError):
        atomic_write_json(p, {"a": 2})
    assert json.loads(p.read_text()) == {"a": 1}
    assert [f.name for f in tmp_path.iterdir()] == ["m.json"]     # temp file cleaned up


def test_atomic_write_unserialisable_touches_nothing(tmp_path):
    p = tmp_path / "m.json"
    atomic_write_json(p, {"a": 1})
    with pytest.raises(TypeError):
        atomic_write_json(p, {"a": object()})
    assert json.loads(p.read_text()) == {"a": 1}
