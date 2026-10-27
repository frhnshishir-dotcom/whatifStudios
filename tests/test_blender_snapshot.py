"""Run blender_snapshot.take_snapshot against a tiny fake `bpy`, so typos are caught without Blender."""
import importlib
import json
import sys
import types
from types import SimpleNamespace as NS

import pytest

from snapshot_check import picture_lock_state


def kp(f):
    return NS(co=(float(f), 0.0))


def obj(name, frames, layered=False):
    fc = NS(data_path="location", keyframe_points=[kp(f) for f in frames])
    if layered:     # Blender 4.4+/5.x layered action
        action = NS(layers=[NS(strips=[NS(channelbags=[NS(fcurves=[fc])])])])
    else:
        action = NS(fcurves=[fc, NS(data_path="rotation_euler", keyframe_points=[kp(999)])])
    return NS(name=name, animation_data=NS(action=action))


@pytest.fixture
def fake_bpy(monkeypatch):
    shots = [("CAM_01_Aerial_Approach", 1, 150), ("CAM_02_Billboards", 151, 300),
             ("CAM_03_Intersection", 301, 480), ("CAM_04_Skyline_Pullback", 481, 615)]
    objects = []
    for i, (c, a, b) in enumerate(shots):
        objects += [obj(c, [a, b], layered=i % 2 == 0), obj(c + "_Aim", [a, b])]
    objects.append(NS(name="CAR_01", animation_data=None))
    cams = {o.name: o for o in objects}
    render = NS(engine="BLENDER_EEVEE", resolution_x=720, resolution_y=1280, resolution_percentage=100, fps=30,
                fps_base=1.0, filepath="//episodes/ai_disappeared_final_30fps/frames/frame_",
                image_settings=NS(file_format="PNG", color_mode="RGB"), use_overwrite=False, use_placeholder=False)
    sc = NS(name="EP001_City_v2", render=render, eevee=NS(taa_render_samples=16), frame_start=1, frame_end=615,
            timeline_markers=[NS(name=f"SHOT_{i + 1}", frame=a, camera=cams[c]) for i, (c, a, b) in enumerate(shots)],
            camera=cams["CAM_01_Aerial_Approach"], objects=objects)
    bpy = types.ModuleType("bpy")
    bpy.app = NS(version_string="5.2.2 LTS")
    bpy.data = NS(filepath="", is_dirty=False, scenes={"EP001_City_v2": sc})
    bpy.path = NS(abspath=lambda p: p.replace("//", "C:/WhatIfStudio/"))
    bpy.context = NS(scene=sc)
    monkeypatch.setitem(sys.modules, "bpy", bpy)
    sys.modules.pop("blender_snapshot", None)
    return importlib.import_module("blender_snapshot"), sc


def test_snapshot_shape_and_lock_state(fake_bpy):
    mod, sc = fake_bpy
    snap = mod.take_snapshot(sc)
    json.dumps(snap)
    assert snap["render"]["samples"] == 16 and snap["render"]["use_overwrite"] is False
    assert snap["camera_keys"]["CAM_03_Intersection"] == [301, 480]
    assert "CAR_01" not in snap["camera_keys"]
    assert snap["markers"][1] == ["SHOT_2", 151, "CAM_02_Billboards"]
    from common import ROOT, load_config
    assert picture_lock_state(snap, load_config(ROOT / "configs" / "ai_disappeared_final_30fps.json")["shots"])[0] \
        == "applied"


def test_main_writes_json(fake_bpy, tmp_path):
    mod, _ = fake_bpy
    out = tmp_path / "snap.json"
    mod.main({"config": "configs/ai_disappeared_final_30fps.json", "out": str(out)})
    assert json.loads(out.read_text())["scene"] == "EP001_City_v2"
