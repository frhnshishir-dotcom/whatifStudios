import json
import os
import time

import pytest

import manifest
from common import config_hash, validate_config
from manifest import ManifestError, manifest_path, read_manifest, start, update
from validate_frames import main as validate_main


def test_start_creates_manifest(cut):
    m = start(cut.cfg, cut.root)
    path = manifest_path(cut.cfg, cut.root)
    assert path == cut.root / "episodes" / "test_cut" / "logs" / "manifest.json"
    assert read_manifest(path) == m
    assert m["config_hash"] == config_hash(cut.cfg) and m["missing"] == list(range(1, 11))
    assert m["started_at"] is not None and m["adopted"] is False


def test_start_is_idempotent(cut):
    a = start(cut.cfg, cut.root)
    b = start(cut.cfg, cut.root)
    assert a["render_id"] == b["render_id"]


def test_start_refuses_changed_config(cut):
    start(cut.cfg, cut.root)
    changed = validate_config({**cut.cfg, "fps": 24})
    with pytest.raises(ManifestError, match="config changed"):
        start(changed, cut.root)


def test_validation_only_change_does_not_invalidate(cut):
    a = start(cut.cfg, cut.root)
    b = start(validate_config({**cut.cfg, "black_threshold": 10.0, "audio": "optional"}), cut.root)
    assert a["render_id"] == b["render_id"]


def test_replace_archives_and_marks_old_frames_stale(cut):
    cut.fill()
    old_t = time.time() - 3600
    for p in cut.frames.iterdir():
        os.utime(p, (old_t, old_t))
    first = start(cut.cfg, cut.root, adopt=True)
    changed = validate_config({**cut.cfg, "samples": 32})
    second = start(changed, cut.root, replace=True)
    logs = manifest_path(cut.cfg, cut.root).parent
    assert (logs / f"manifest_{first['render_id']}.json").exists()
    assert second["render_id"] != first["render_id"]
    m, rep = update(changed, cut.root)
    assert not rep.ok and m["summary"]["invalid"] == list(range(1, 11))
    assert all(f["status"] == "stale" for f in m["frames"].values())


def test_update_records_frames_and_missing(cut):
    start(cut.cfg, cut.root)
    cut.fill(skip={3, 4})
    cut.frame(9, flat=(0, 0, 0))
    m, rep = update(cut.cfg, cut.root)
    assert m["missing"] == [3, 4]
    assert m["frames"]["1"]["status"] == "ok" and m["frames"]["1"]["width"] == 36
    assert len(m["frames"]["1"]["sha1"]) == 40 and m["frames"]["1"]["size"] > 0
    assert "black" in m["frames"]["9"]["status"]
    assert m["summary"]["complete"] == 7 and m["summary"]["invalid"] == [9] and not m["summary"]["ok"]
    assert read_manifest(manifest_path(cut.cfg, cut.root)) == m


def test_resume_after_interruption(cut):
    """Chunk 1 renders, the session dies, chunk 2 is rendered later: manifest tracks progress across runs."""
    start(cut.cfg, cut.root)
    cut.fill(1, 5)
    m, _ = update(cut.cfg, cut.root)
    assert m["missing"] == [6, 7, 8, 9, 10]
    cut.fill(6, 10)
    m, rep = update(cut.cfg, cut.root)
    assert rep.ok and m["missing"] == [] and m["summary"]["complete"] == 10


def test_pre_existing_frames_are_stale_unless_adopted(cut):
    cut.fill()
    t = time.time() - 60
    for p in cut.frames.iterdir():
        os.utime(p, (t, t))
    start(cut.cfg, cut.root)
    _, rep = update(cut.cfg, cut.root)
    assert {i.code for i in rep.errors} == {"stale"}
    manifest_path(cut.cfg, cut.root).unlink()
    start(cut.cfg, cut.root, adopt=True)
    _, rep = update(cut.cfg, cut.root)
    assert rep.ok


def test_update_without_manifest(cut):
    with pytest.raises(ManifestError, match="start"):
        update(cut.cfg, cut.root)


def test_update_refuses_changed_config(cut):
    start(cut.cfg, cut.root)
    with pytest.raises(ManifestError, match="refusing to mix"):
        update(validate_config({**cut.cfg, "width": 72}), cut.root)


def test_update_never_touches_frames(cut):
    start(cut.cfg, cut.root)
    cut.fill()
    (cut.frames / "frame_0099.png").write_bytes(b"junk")
    before = {p.name: (p.stat().st_mtime, p.read_bytes()) for p in cut.frames.iterdir()}
    update(cut.cfg, cut.root)
    assert {p.name: (p.stat().st_mtime, p.read_bytes()) for p in cut.frames.iterdir()} == before


def test_corrupt_manifest_is_reported(cut):
    p = manifest_path(cut.cfg, cut.root)
    p.parent.mkdir(parents=True)
    p.write_text("{half a fi", encoding="utf-8")
    with pytest.raises(ManifestError):
        read_manifest(p)


def _write_cfg(tmp_path, cfg):
    p = tmp_path / "cfg.json"
    p.write_text(json.dumps(cfg), encoding="utf-8")
    return str(p)


def test_cli_flow(cut, tmp_path, capsys):
    cfg = _write_cfg(tmp_path, cut.cfg)
    base = ["--config", cfg, "--root", str(cut.root)]
    assert manifest.main(["show"] + base) == 2
    assert manifest.main(["start"] + base) == 0
    cut.fill(skip={7})
    assert manifest.main(["update"] + base) == 1
    assert "missing: 7" in capsys.readouterr().out
    cut.frame(7)
    assert manifest.main(["update"] + base) == 0
    assert manifest.main(["show"] + base) == 0
    assert "complete 10/10" in capsys.readouterr().out


def test_validator_cli_uses_manifest(cut, tmp_path):
    cut.fill()
    t = time.time() - 60
    for p in cut.frames.iterdir():
        os.utime(p, (t, t))
    start(cut.cfg, cut.root)
    base = ["--config", _write_cfg(tmp_path, cut.cfg), "--root", str(cut.root)]
    assert validate_main(base) == 1                       # stale vs. manifest
    assert validate_main(base + ["--no-manifest"]) == 0
    other = _write_cfg(tmp_path, {**cut.cfg, "fps": 24})
    assert validate_main(["--config", other, "--root", str(cut.root), "--no-manifest"]) == 0
    assert validate_main(["--config", other, "--root", str(cut.root)]) == 1   # manifest_mismatch
