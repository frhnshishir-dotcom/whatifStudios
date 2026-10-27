import copy

import pytest

from common import load_config, ROOT
from snapshot_check import compare, picture_lock_state

CFG = load_config(ROOT / "configs" / "ai_disappeared_final_30fps.json")
SHOTS = CFG["shots"]


def locked_snapshot():
    keys = {}
    for cam, a, b in SHOTS:
        keys[cam] = [a, b]
        keys[cam + "_Aim"] = [a, b]
    return {
        "scene": "EP001_City_v2", "blend_file": r"C:\Users\User\Documents\Blender\WhatIfStudio\checkpoints"
                                                r"\picturelock_30fps_20261027_154727\master_city_picturelock_30fps_renderprep.blend",
        "render": {"engine": "BLENDER_EEVEE", "samples": 16, "resolution_x": 720, "resolution_y": 1280,
                   "resolution_percentage": 100, "fps": 30, "fps_base": 1.0, "frame_start": 1, "frame_end": 615,
                   "filepath": "//episodes/ai_disappeared_final_30fps/frames/frame_",
                   "filepath_abs": r"C:\Users\User\Documents\Blender\WhatIfStudio\episodes"
                                   r"\ai_disappeared_final_30fps\frames\frame_",
                   "file_format": "PNG", "color_mode": "RGB", "use_overwrite": False, "use_placeholder": False},
        "markers": [[f"SHOT_{i + 1}", a, cam] for i, (cam, a, b) in enumerate(SHOTS)],
        "camera_keys": keys,
    }


def v6_snapshot():
    s = locked_snapshot()
    s["render"].update(fps=24, frame_end=288)
    old = [("CAM_01_Aerial_Approach", 1, 72), ("CAM_02_Billboards", 73, 144),
           ("CAM_03_Intersection", 145, 216), ("CAM_04_Skyline_Pullback", 217, 288)]
    s["markers"] = [[f"SHOT_{i + 1}", a, c] for i, (c, a, b) in enumerate(old)]
    s["camera_keys"] = {c: list(range(a, b + 1, 12)) for c, a, b in old}
    return s


def statuses(cfg, snap):
    return {name: st for st, name, _ in compare(cfg, snap)}


def test_locked_scene_all_ok():
    st = statuses(CFG, locked_snapshot())
    assert set(st.values()) == {"ok"}, st
    assert picture_lock_state(locked_snapshot(), SHOTS)[0] == "applied"


def test_v6_scene_is_not_locked():
    assert picture_lock_state(v6_snapshot(), SHOTS)[0] == "not_applied"
    assert statuses(CFG, v6_snapshot())["picture lock"] == "fail"


def test_double_locked_scene_is_unknown():
    """picture_lock.py run twice: markers still at the new starts but camera keys are wrong/extra."""
    s = locked_snapshot()
    s["camera_keys"]["CAM_03_Intersection"] = [1, 301, 480]
    assert picture_lock_state(s, SHOTS)[0] == "unknown"
    assert statuses(CFG, s)["picture lock"] == "fail"


@pytest.mark.parametrize("change,check", [
    ({"resolution_percentage": 50}, "render size"),
    ({"resolution_x": 540}, "render size"),
    ({"fps": 24}, "frame rate"),
    ({"fps_base": 1.001}, "frame rate"),
    ({"frame_end": 600}, "frame range"),
    ({"file_format": "JPEG"}, "file format"),
    ({"color_mode": "RGBA"}, "file format"),
    ({"use_overwrite": True}, "no overwrite"),
    ({"use_placeholder": True}, "no placeholders"),
    ({"samples": 32}, "samples"),
    ({"filepath_abs": r"C:\x\episodes\ai_disappeared_final\frames\frame_"}, "output path"),
    ({"filepath_abs": r"C:\x\episodes\ai_disappeared_final_30fps\previews\frame_"}, "output path"),
    ({"filepath_abs": "", "filepath": ""}, "output path"),
])
def test_setting_mismatch_fails(change, check):
    s = locked_snapshot()
    s["render"].update(change)
    assert statuses(CFG, s)[check] == "fail"


def test_output_path_forms():
    s = locked_snapshot()
    for fp in ("/home/u/WhatIfStudio/episodes/ai_disappeared_final_30fps/frames/frame_",
               r"D:\Render\episodes\AI_DISAPPEARED_FINAL_30FPS\frames\frame_####"):
        s["render"]["filepath_abs"] = fp
        assert statuses(CFG, s)["output path"] == "ok", fp


def test_engine_and_source_are_warnings():
    s = locked_snapshot()
    s["render"]["engine"] = "CYCLES"
    s["blend_file"] = r"C:\x\master_city_v6.blend"
    st = statuses(CFG, s)
    assert st["engine"] == "warn" and st["source .blend"] == "warn"
    s["blend_file"] = ""
    assert statuses(CFG, s)["source .blend"] == "warn"


def test_wrong_scene_name():
    s = locked_snapshot()
    s["scene"] = "EP001_City"
    assert statuses(CFG, s)["scene name"] == "fail"


def test_bad_shots_config_rejected():
    from common import ConfigError, validate_config
    base = {k: CFG[k] for k in ("cut", "frame_start", "frame_end", "fps", "width", "height", "audio")}
    for shots in ([["A", 1, 700]], [["A", 10, 5]], [["A", 1, 100], ["B", 50, 200]], [["A", 1]]):
        with pytest.raises(ConfigError):
            validate_config({**base, "shots": shots})
    with pytest.raises(ConfigError):
        validate_config({**base, "picture_lock": "yes"})
