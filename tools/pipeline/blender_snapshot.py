"""
WhatIfStudio pipeline - write a READ-ONLY snapshot of a scene's render settings, markers and camera keys to
episodes/<cut>/logs/blender_snapshot.json, for preflight.py to check outside Blender.
Saves nothing, renders nothing, changes nothing in the scene.

Inside the open Blender session (MCP / Text Editor), with the README's run() helper:
    run("pipeline\\blender_snapshot.py", {"config": "configs/ai_disappeared_final_30fps.json"})
Optional ARGS keys: "scene" (default: config "scene", else the active scene), "out" (another JSON path).
"""
import sys
import time
from pathlib import Path

import bpy

HERE = Path(globals().get("__file__") or bpy.path.abspath("//tools/pipeline/blender_snapshot.py")).resolve().parent
sys.path.insert(0, str(HERE))
from common import ROOT, atomic_write_json, cut_dir, load_config  # noqa: E402


def _fcurves(idb):
    """Action fcurves for both legacy and layered (Blender 4.4+/5.x) actions, same as picture_lock.py."""
    ad = getattr(idb, "animation_data", None)
    if not ad or not ad.action:
        return []
    a = ad.action
    if hasattr(a, "fcurves"):
        return list(a.fcurves)
    return [fc for lay in a.layers for st in lay.strips for cb in st.channelbags for fc in cb.fcurves]


def location_key_frames(ob):
    frames = set()
    for fc in _fcurves(ob):
        if fc.data_path == "location":
            frames.update(int(round(kp.co[0])) for kp in fc.keyframe_points)
    return sorted(frames)


def take_snapshot(sc) -> dict:
    r = sc.render
    eevee = getattr(sc, "eevee", None)
    return {
        "schema": 1,
        "taken_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "blender_version": bpy.app.version_string,
        "blend_file": bpy.data.filepath,
        "is_dirty": bool(bpy.data.is_dirty),
        "scene": sc.name,
        "render": {
            "engine": r.engine,
            "samples": getattr(eevee, "taa_render_samples", None),
            "resolution_x": r.resolution_x, "resolution_y": r.resolution_y,
            "resolution_percentage": r.resolution_percentage,
            "fps": r.fps, "fps_base": r.fps_base,
            "frame_start": sc.frame_start, "frame_end": sc.frame_end,
            "filepath": r.filepath, "filepath_abs": bpy.path.abspath(r.filepath),
            "file_format": r.image_settings.file_format, "color_mode": r.image_settings.color_mode,
            "use_overwrite": r.use_overwrite, "use_placeholder": r.use_placeholder,
        },
        "markers": [[m.name, m.frame, m.camera.name if m.camera else None] for m in sc.timeline_markers],
        "camera": sc.camera.name if sc.camera else None,
        "camera_keys": {ob.name: location_key_frames(ob) for ob in sc.objects if ob.name.startswith("CAM_")},
    }


def main(args: dict) -> dict:
    cfg_path = Path(args["config"])
    if not cfg_path.is_absolute():
        cfg_path = ROOT / cfg_path
    cfg = load_config(cfg_path)
    name = args.get("scene") or cfg.get("scene")
    sc = bpy.data.scenes[name] if name else bpy.context.scene
    snap = take_snapshot(sc)
    out = Path(args["out"]) if args.get("out") else cut_dir(cfg, ROOT) / "logs" / "blender_snapshot.json"
    atomic_write_json(out, snap)
    print(f"[snapshot] {sc.name} -> {out}")
    return snap


if __name__ == "__main__":
    A = dict(globals().get("ARGS") or {})
    if "--" in sys.argv:                       # blender --python blender_snapshot.py -- --config <cfg>
        import argparse
        ap = argparse.ArgumentParser()
        ap.add_argument("--config", required=True)
        ap.add_argument("--scene")
        ap.add_argument("--out")
        A.update({k: v for k, v in vars(ap.parse_args(sys.argv[sys.argv.index("--") + 1:])).items() if v})
    result = main(A)
