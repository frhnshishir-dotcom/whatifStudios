import json
import os
import shutil
import time

from validate_frames import main, validate


def codes(rep, severity="error"):
    return sorted({i.code for i in rep.issues if i.severity == severity})


def frames_with(rep, code):
    return sorted(i.frame for i in rep.issues if i.code == code)


def test_clean_sequence_passes(cut):
    cut.fill()
    rep = validate(cut.cfg, cut.frames)
    assert rep.ok and rep.issues == [] and len(rep.frames) == 10


def test_missing_frames(cut):
    cut.fill(skip={5, 6, 10})
    rep = validate(cut.cfg, cut.frames)
    assert codes(rep) == ["missing"] and frames_with(rep, "missing") == [5, 6, 10]
    assert rep.missing() == [5, 6, 10]


def test_missing_folder(cut):
    shutil.rmtree(cut.frames)
    assert codes(validate(cut.cfg, cut.frames)) == ["missing_dir"]


def test_extra_frames_outside_range(cut):
    cut.fill()
    cut.frame(11)
    cut.frame(0)
    rep = validate(cut.cfg, cut.frames)
    assert codes(rep) == ["extra"] and frames_with(rep, "extra") == [0, 11]


def test_duplicate_frame_number_with_other_padding(cut):
    cut.fill()
    cut.frame(4, digits=5)
    rep = validate(cut.cfg, cut.frames)
    assert codes(rep) == ["duplicate_number"] and frames_with(rep, "duplicate_number") == [4]


def test_nonstandard_padding_is_warning(cut):
    cut.fill(skip={3})
    cut.frame(3, digits=5)
    rep = validate(cut.cfg, cut.frames)
    assert rep.ok and codes(rep, "warning") == ["nonstandard_name"]


def test_wrong_size(cut):
    cut.fill()
    cut.frame(7, size=(18, 32))
    rep = validate(cut.cfg, cut.frames)
    assert "wrong_size" in codes(rep) and frames_with(rep, "wrong_size") == [7]


def test_wrong_colour_mode(cut):
    cut.fill()
    cut.frame(2, mode="RGBA")
    rep = validate(cut.cfg, cut.frames)
    assert codes(rep) == ["wrong_mode"]


def test_empty_file(cut):
    cut.fill()
    cut.path(3).write_bytes(b"")
    assert frames_with(validate(cut.cfg, cut.frames), "empty") == [3]


def test_truncated_png(cut):
    cut.fill()
    data = cut.path(8).read_bytes()
    cut.path(8).write_bytes(data[: len(data) // 2])
    assert frames_with(validate(cut.cfg, cut.frames), "unreadable") == [8]


def test_garbage_file_named_png(cut):
    cut.fill()
    cut.path(9).write_text("Blender crashed here", encoding="utf-8")
    assert frames_with(validate(cut.cfg, cut.frames), "unreadable") == [9]


def test_jpeg_named_png(cut):
    from PIL import Image
    cut.fill()
    Image.new("RGB", (36, 64), (120, 120, 120)).save(cut.path(5), format="JPEG")
    assert frames_with(validate(cut.cfg, cut.frames), "not_png") == [5]


def test_black_frame(cut):
    cut.fill()
    cut.frame(6, flat=(1, 1, 1))
    rep = validate(cut.cfg, cut.frames)
    assert frames_with(rep, "black") == [6]


def test_black_frame_allowed_in_dark_range(make_cut):
    c = make_cut(dark_ranges=[[6, 7]], min_size_ratio=0.0)
    c.fill()
    c.frame(6, flat=(0, 0, 0))
    c.frame(9, flat=(0, 0, 0))
    rep = validate(c.cfg, c.frames)
    assert frames_with(rep, "black") == [9]


def test_undersized_frame(cut):
    cut.fill()
    cut.frame(5, flat=(128, 128, 128))      # valid, not black, but compresses to almost nothing
    rep = validate(cut.cfg, cut.frames)
    assert codes(rep) == ["undersized"] and frames_with(rep, "undersized") == [5]


def test_repeated_frame_is_warning(cut):
    cut.fill()
    shutil.copyfile(cut.path(4), cut.path(5))
    rep = validate(cut.cfg, cut.frames)
    assert rep.ok and frames_with(rep, "repeated_frame") == [5]


def test_stray_files_are_warnings(cut):
    cut.fill()
    (cut.frames / "frame_0003_old.png").write_bytes(b"x")
    (cut.frames / "Thumbs.db").write_bytes(b"x")
    rep = validate(cut.cfg, cut.frames)
    assert rep.ok and codes(rep, "warning") == ["stray_file"] and len(rep.warnings) == 1


def test_stale_frames(cut):
    cut.fill()
    since = time.time()
    old = since - 3600
    for n in (2, 3):
        os.utime(cut.path(n), (old, old))
    for n in (1, 4, 5, 6, 7, 8, 9, 10):
        os.utime(cut.path(n), (since + 5, since + 5))
    rep = validate(cut.cfg, cut.frames, since=since)
    assert codes(rep) == ["stale"] and frames_with(rep, "stale") == [2, 3]


def test_cli_exit_codes_and_json(cut, tmp_path):
    cfg_path = tmp_path / "cfg.json"
    cfg_path.write_text(json.dumps(cut.cfg), encoding="utf-8")
    args = ["--config", str(cfg_path), "--root", str(cut.root)]
    cut.fill(skip={4})
    out = tmp_path / "report.json"
    assert main(args + ["--json", str(out)]) == 1
    assert json.loads(out.read_text())["ok"] is False
    cut.frame(4)
    assert main(args) == 0
    cfg_path.write_text("{}", encoding="utf-8")
    assert main(args) == 2


def test_frame_written_just_after_start_is_not_stale(cut):
    """Coarse file timestamps can put a fresh frame a few ms before the manifest's start time."""
    cut.fill()
    since = time.time()
    t = since - 0.5
    os.utime(cut.path(1), (t, t))
    for n in range(2, 11):
        os.utime(cut.path(n), (since + 1, since + 1))
    assert validate(cut.cfg, cut.frames, since=since).ok
