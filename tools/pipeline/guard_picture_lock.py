"""
WhatIfStudio pipeline - run this in Blender BEFORE tools/final/picture_lock.py. Read-only.
It raises (and so stops the exec) unless the scene is still the original 24 fps / 288-frame v6 layout that
picture_lock.py expects. A second run of picture_lock.py on a locked scene breaks every camera move.

    run("pipeline\\guard_picture_lock.py", {"config": "configs/ai_disappeared_final_30fps.json"})
    run("final\\picture_lock.py")      # only if the guard printed OK
"""
import sys
from pathlib import Path

import bpy

HERE = Path(globals().get("__file__") or bpy.path.abspath("//tools/pipeline/guard_picture_lock.py")).resolve().parent
sys.path.insert(0, str(HERE))
from blender_snapshot import take_snapshot  # noqa: E402
from common import ROOT, load_config  # noqa: E402
from snapshot_check import picture_lock_state  # noqa: E402

A = dict(globals().get("ARGS") or {})
cfg_path = Path(A.get("config", "configs/ai_disappeared_final_30fps.json"))
cfg = load_config(cfg_path if cfg_path.is_absolute() else ROOT / cfg_path)
sc = bpy.data.scenes[A.get("scene") or cfg.get("scene") or bpy.context.scene.name]
state, why = picture_lock_state(take_snapshot(sc), cfg.get("shots"))
if state != "not_applied":
    raise RuntimeError(f"[guard] do NOT run picture_lock.py on scene {sc.name!r}: {state} ({why})")
print(f"[guard] OK: {sc.name} is the pre-lock v6 layout; picture_lock.py may run once.")
