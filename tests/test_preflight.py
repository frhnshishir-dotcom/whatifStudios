import json
from collections import namedtuple

import pytest

import preflight
from common import validate_config
from manifest import start
from preflight import PIPELINE_FILES, check_blend, main, run_checks
from test_snapshot_check import locked_snapshot

Usage = namedtuple("Usage", "total used free")
PLENTY = lambda _p: Usage(0, 0, 500 * 1024 ** 3)          # noqa: E731


@pytest.fixture
def proj(make_cut, tools):
    c = make_cut(blend="scene.blend", scene="EP001_City_v2", picture_lock="applied",
                 frame_end=615, width=720, height=1280,
                 shots=[["CAM_01_Aerial_Approach", 1, 150], ["CAM_02_Billboards", 151, 300],
                        ["CAM_03_Intersection", 301, 480], ["CAM_04_Skyline_Pullback", 481, 615]])
    for f in PIPELINE_FILES:
        (c.root / f).parent.mkdir(parents=True, exist_ok=True)
        (c.root / f).write_text("#")
    (c.root / "scene.blend").write_bytes(b"BLENDER-v502RENDH" + bytes(100))
    for sub in ("output", "logs"):
        (c.frames.parent / sub).mkdir()
    return c


def table(results):
    return {name: st for st, name, _ in results}


def test_ready_project(proj):
    start(proj.cfg, proj.root)
    snap = proj.frames.parent / "logs" / "blender_snapshot.json"
    s = locked_snapshot()
    s["render"]["filepath_abs"] = str(proj.root / "episodes" / "test_cut" / "frames" / "frame_")
    s["blend_file"] = str(proj.root / "scene.blend")
    snap.write_text(json.dumps(s))
    res = run_checks(proj.cfg, proj.root, disk_usage=PLENTY)
    bad = [r for r in res if r[0] != "ok"]
    assert bad == [], bad
    assert table(res)["blender: picture lock"] == "ok"


def test_missing_snapshot_and_manifest_are_warnings(proj):
    t = table(run_checks(proj.cfg, proj.root, disk_usage=PLENTY))
    assert t["blender settings"] == "warn" and t["manifest"] == "warn"
    assert "fail" not in t.values()


def test_lfs_pointer_blend_fails(proj):
    (proj.root / "scene.blend").write_text("version https://git-lfs.github.com/spec/v1\noid sha256:abc\n")
    st, detail = check_blend(proj.root / "scene.blend")
    assert st == "fail" and "git lfs pull" in detail
    assert table(run_checks(proj.cfg, proj.root, disk_usage=PLENTY))["scene .blend"] == "fail"


def test_compressed_blend_ok_and_junk_fails(tmp_path):
    p = tmp_path / "a.blend"
    p.write_bytes(b"\x28\xb5\x2f\xfd" + bytes(60))
    assert check_blend(p)[0] == "ok"
    p.write_bytes(b"PK\x03\x04")
    assert check_blend(p)[0] == "fail"
    assert check_blend(tmp_path / "none.blend")[0] == "fail"


def test_missing_required_file(proj):
    (proj.root / "tools" / "pipeline" / "verify_mp4.py").unlink()
    assert table(run_checks(proj.cfg, proj.root, disk_usage=PLENTY))["required files"] == "fail"


def test_disk_space(proj):
    low = lambda _p: Usage(0, 0, 100 * 1024 ** 2)     # noqa: E731
    assert table(run_checks(proj.cfg, proj.root, disk_usage=low))["disk space"] == "fail"


def test_missing_ffmpeg_dir(proj):
    cfg = validate_config({**proj.cfg, "ffmpeg_dir": str(proj.root / "nope")})
    t = table(run_checks(cfg, proj.root, disk_usage=PLENTY))
    assert t["ffmpeg"] == "fail" and t["ffprobe"] == "fail"


def test_manifest_mismatch_fails(proj):
    start(proj.cfg, proj.root)
    other = validate_config({**proj.cfg, "samples": 64})
    assert table(run_checks(other, proj.root, disk_usage=PLENTY))["manifest"] == "fail"


def test_frames_without_manifest_hint(proj):
    proj.frame(1, size=(720, 1280))
    detail = [d for st, n, d in run_checks(proj.cfg, proj.root, disk_usage=PLENTY) if n == "manifest"][0]
    assert "--adopt" in detail


def test_leftover_partials_warn(proj):
    (proj.frames.parent / "output" / "x.20260101_000000_abc.partial.mp4").write_bytes(b"")
    assert table(run_checks(proj.cfg, proj.root, disk_usage=PLENTY))["leftovers"] == "warn"


def test_snapshot_mismatch_reported(proj):
    """Wrong settings in the open Blender scene are caught before a long render starts."""
    s = locked_snapshot()
    s["render"]["use_overwrite"] = True
    s["render"]["fps"] = 24
    snap = proj.root / "snap.json"
    snap.write_text(json.dumps(s))
    t = table(run_checks(proj.cfg, proj.root, snapshot=snap, disk_usage=PLENTY))
    assert t["blender: no overwrite"] == "fail" and t["blender: frame rate"] == "fail"


def test_cli_exit_codes(proj, tmp_path, monkeypatch):
    monkeypatch.setattr(preflight.shutil, "disk_usage", PLENTY)
    cfg = tmp_path / "c.json"
    cfg.write_text(json.dumps(proj.cfg))
    base = ["--config", str(cfg), "--root", str(proj.root)]
    assert main(base) == 0                     # warnings only
    assert main(base + ["--strict"]) == 1
    (proj.root / "scene.blend").unlink()
    assert main(base) == 1
    cfg.write_text("{}")  # invalid config
    assert main(base) == 2
