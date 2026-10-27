import json
import os
import sys
import time
import types
from contextlib import contextmanager
from types import SimpleNamespace as NS

import pytest

import resume
from common import validate_config
from manifest import read_manifest, manifest_path, start
from resume import chunk_snippet, chunks, main


def cfg_with(**kw):
    return validate_config({"cut": "c", "frame_start": 1, "frame_end": 615, "fps": 30, "width": 720,
                            "height": 1280, "audio": "forbidden", **kw})


SHOTS = [["CAM_01", 1, 150], ["CAM_02", 151, 300], ["CAM_03", 301, 480], ["CAM_04", 481, 615]]


def test_chunks_split_at_shots_and_max():
    cfg = cfg_with(shots=SHOTS, max_chunk=100)
    got = chunks(list(range(140, 160)) + [400] + list(range(481, 616)), cfg)
    assert got == [(140, 150, "CAM_01"), (151, 159, "CAM_02"), (400, 400, "CAM_03"),
                   (481, 580, "CAM_04"), (581, 615, "CAM_04")]


def test_chunks_without_shots():
    assert chunks([1, 2, 3, 10], cfg_with()) == [(1, 3, "(all)"), (10, 10, "(all)")]


def write_cfg(tmp_path, cfg):
    p = tmp_path / "cfg.json"
    p.write_text(json.dumps(cfg), encoding="utf-8")
    return ["--config", str(p)]


def test_complete_sequence(cut, tmp_path, capsys):
    start(cut.cfg, cut.root)
    cut.fill()
    assert main(write_cfg(tmp_path, cut.cfg) + ["--root", str(cut.root)]) == 0
    assert "sequence complete" in capsys.readouterr().out


def test_interrupted_render_lists_missing_chunks(cut, tmp_path, capsys):
    start(cut.cfg, cut.root)
    cut.fill(1, 6)                                       # Blender froze after frame 6
    assert main(write_cfg(tmp_path, cut.cfg) + ["--root", str(cut.root)]) == 1
    out = capsys.readouterr().out
    assert "4 frame(s) to render in 1 chunk(s)" in out and "sc.frame_start, sc.frame_end = 7, 10" in out
    assert "picture_lock" not in out                     # this cut has no picture_lock setting


def test_bad_frames_must_be_quarantined_then_rerendered(cut, tmp_path, capsys):
    start(cut.cfg, cut.root)
    cut.fill()
    cut.frame(4, flat=(0, 0, 0))                        # black frame from a frozen session
    cut.frame(12)                                        # leftover from a longer cut
    cut.frame(6, digits=5)                               # duplicate number
    base = write_cfg(tmp_path, cut.cfg) + ["--root", str(cut.root)]
    assert main(base) == 1
    out = capsys.readouterr().out
    assert "3 bad file(s) on disk block a re-render" in out and "--quarantine" in out
    assert cut.path(4).exists()                          # listing never moves anything
    assert main(base + ["--quarantine"]) == 1
    out = capsys.readouterr().out
    assert "moved 3 file(s)" in out and "sc.frame_start, sc.frame_end = 4, 4" in out
    rejected = next((cut.root / "episodes" / "test_cut" / "logs").glob("rejected_*"))
    moved = json.loads((rejected / "moved.json").read_text())
    assert sorted(os.path.basename(r["from"]) for r in moved) == ["frame_00006.png", "frame_0004.png",
                                                                  "frame_0012.png"]
    assert cut.path(6).exists() and not cut.path(4).exists()
    cut.frame(4)                                         # the re-rendered frame
    assert main(base) == 0
    hist = read_manifest(manifest_path(cut.cfg, cut.root))["history"]
    assert hist[-1]["complete"] == 10 and len(hist) >= 3


def test_quarantine_refuses_mass_move(cut, tmp_path, capsys):
    cut.fill()
    t = time.time() - 600
    for p in cut.frames.iterdir():
        os.utime(p, (t, t))
    start(cut.cfg, cut.root)                             # forgot --adopt: every frame is "stale"
    base = write_cfg(tmp_path, cut.cfg) + ["--root", str(cut.root)]
    assert main(base + ["--quarantine"]) == 2
    assert "--adopt" in capsys.readouterr().err
    assert len(list(cut.frames.iterdir())) == 10


def test_changed_config_refuses(cut, tmp_path, capsys):
    start(cut.cfg, cut.root)
    cut.fill(1, 5)
    other = validate_config({**cut.cfg, "fps": 24})
    assert main(write_cfg(tmp_path, other) + ["--root", str(cut.root)]) == 2
    assert "refusing to mix" in capsys.readouterr().err


def test_picture_lock_warning(make_cut, tmp_path, capsys):
    c = make_cut(picture_lock="applied", blend="x.blend")
    start(c.cfg, c.root)
    assert main(write_cfg(tmp_path, c.cfg) + ["--root", str(c.root), "--snippets", "none"]) == 1
    out = capsys.readouterr().out
    assert "do NOT run tools/final/picture_lock.py" in out and "import bpy" not in out


# ---------------------------------------------------------------- the generated Blender snippet, against fake bpy
class FakeOps:
    def __init__(self, sc):
        self.sc, self.calls = sc, []

    def render(self, mode, animation):
        self.calls.append((mode, animation, self.sc.frame_start, self.sc.frame_end))


def fake_bpy(**render_over):
    r = NS(resolution_x=720, resolution_y=1280, resolution_percentage=100, fps=30, fps_base=1.0,
           use_overwrite=False, use_placeholder=False, filepath="//episodes/c/frames/frame_")
    for k, v in render_over.items():
        setattr(r, k, v)
    sc = NS(render=r, frame_start=1, frame_end=615)
    ops = FakeOps(sc)

    @contextmanager
    def temp_override(**_):
        yield
    bpy = types.ModuleType("bpy")
    bpy.data = NS(scenes={"EP001_City_v2": sc})
    bpy.context = NS(window_manager=NS(windows=[object()]), temp_override=temp_override)
    bpy.app = NS(is_job_running=lambda _: False, handlers=NS(render_complete=[], render_cancel=[]))
    bpy.path = NS(abspath=lambda p: p.replace("//", "C:\\WhatIfStudio\\" if os.sep == "\\" else "/w/"))
    bpy.ops = NS(render=NS(render=ops.render))
    return bpy, sc, ops


def run_snippet(code, bpy, monkeypatch):
    monkeypatch.setitem(sys.modules, "bpy", bpy)
    exec(compile(code, "<snippet>", "exec"), {})


def test_snippet_starts_chunk_and_restores_range(monkeypatch):
    bpy, sc, ops = fake_bpy()
    run_snippet(chunk_snippet(cfg_with(scene="EP001_City_v2"), 301, 480), bpy, monkeypatch)
    assert ops.calls == [("INVOKE_DEFAULT", True, 301, 480)]
    assert len(bpy.app.handlers.render_complete) == 1
    bpy.app.handlers.render_complete[0]()                 # Blender fires the handler when the chunk ends
    assert (sc.frame_start, sc.frame_end) == (1, 615)
    assert bpy.app.handlers.render_complete == [] and bpy.app.handlers.render_cancel == []


@pytest.mark.parametrize("over,msg", [
    ({"use_overwrite": True}, "use_overwrite"), ({"resolution_percentage": 50}, "render size"),
    ({"fps": 24}, "frame rate"), ({"filepath": "//episodes/other/frames/frame_"}, "output folder"),
])
def test_snippet_refuses_wrong_settings(monkeypatch, over, msg):
    bpy, sc, ops = fake_bpy(**over)
    with pytest.raises(AssertionError, match=msg):
        run_snippet(chunk_snippet(cfg_with(scene="EP001_City_v2"), 1, 150), bpy, monkeypatch)
    assert ops.calls == [] and (sc.frame_start, sc.frame_end) == (1, 615)


def test_snippet_refuses_when_render_running(monkeypatch):
    bpy, sc, ops = fake_bpy()
    bpy.app.is_job_running = lambda _: True
    with pytest.raises(AssertionError, match="still running"):
        run_snippet(chunk_snippet(cfg_with(scene="EP001_City_v2"), 1, 150), bpy, monkeypatch)
    assert ops.calls == []
