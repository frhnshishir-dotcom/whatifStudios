"""
WhatIfStudio pipeline - compare a Blender scene snapshot (written by blender_snapshot.py inside Blender) with the cut
config, and tell whether picture_lock.py has already been applied. Pure Python: runs outside Blender.
"""
from __future__ import annotations

from pathlib import PureWindowsPath

# picture_lock.py starts from the v6 scene: 24 fps, frames 1-288, shots at 1/73/145/217 (its OLD table).
PRE_LOCK = {"fps": 24, "frame_end": 288, "shot_starts": [1, 73, 145, 217]}


def picture_lock_state(snap: dict, shots) -> tuple[str, str]:
    """('applied' | 'not_applied' | 'unknown', reason). `shots` = cfg["shots"]: [[camera, first, last], ...]."""
    r = snap.get("render", {})
    markers = sorted(snap.get("markers", []), key=lambda m: m[1])
    starts = [m[1] for m in markers]
    if shots:
        want_starts = [s[1] for s in shots]
        cams_ok = [m[2] for m in markers] == [s[0] for s in shots]
        keys = snap.get("camera_keys", {})
        keys_ok = all(sorted(set(keys.get(obj, []))) == [a, b]
                      for cam, a, b in shots for obj in (cam, cam + "_Aim"))
        if starts == want_starts and cams_ok and keys_ok and r.get("frame_end") == shots[-1][2]:
            return "applied", "markers, camera bindings and camera/aim keys match the locked shot list"
    if r.get("fps") == PRE_LOCK["fps"] and r.get("frame_end") == PRE_LOCK["frame_end"] \
            and starts == PRE_LOCK["shot_starts"]:
        return "not_applied", "scene is still the 24 fps / 288-frame v6 layout"
    return "unknown", f"markers at {starts}, fps {r.get('fps')}, frames {r.get('frame_start')}-{r.get('frame_end')}"


def _path_tail(p: str, n: int):
    return tuple(part.lower() for part in PureWindowsPath(p).parts[-n:])   # handles / and \\ and drive letters


def compare(cfg: dict, snap: dict) -> list:
    """List of (status, name, detail) where status is 'ok' | 'warn' | 'fail'."""
    out = []
    r = snap.get("render", {})

    def check(name, good, detail, bad="fail"):
        out.append(("ok" if good else bad, name, detail))

    if cfg.get("scene"):
        check("scene name", snap.get("scene") == cfg["scene"], f"{snap.get('scene')} (config: {cfg['scene']})")
    pct = r.get("resolution_percentage", 100)
    w, h = (int(r.get("resolution_x", 0) * pct / 100), int(r.get("resolution_y", 0) * pct / 100))
    check("render size", (w, h) == (cfg["width"], cfg["height"]),
          f"{r.get('resolution_x')}x{r.get('resolution_y')} at {pct}% = {w}x{h} (config: {cfg['width']}x{cfg['height']})")
    fps_ok = r.get("fps") == cfg["fps"] and abs(float(r.get("fps_base", 1.0)) - 1.0) < 1e-6
    check("frame rate", fps_ok, f"{r.get('fps')} / {r.get('fps_base')} (config: {cfg['fps']})")
    check("frame range", (r.get("frame_start"), r.get("frame_end")) == (cfg["frame_start"], cfg["frame_end"]),
          f"{r.get('frame_start')}-{r.get('frame_end')} (config: {cfg['frame_start']}-{cfg['frame_end']})")
    check("file format", r.get("file_format") == "PNG" and r.get("color_mode") == cfg["color_mode"],
          f"{r.get('file_format')} {r.get('color_mode')} (config: PNG {cfg['color_mode']})")
    check("no overwrite", r.get("use_overwrite") is False,
          f"use_overwrite={r.get('use_overwrite')} (must be False so re-runs only fill missing frames)")
    check("no placeholders", r.get("use_placeholder") is False,
          f"use_placeholder={r.get('use_placeholder')} (placeholders look like finished frames)")
    check("engine", str(r.get("engine", "")).startswith("BLENDER_EEVEE"), f"{r.get('engine')}", bad="warn")
    if cfg.get("samples") is not None:
        check("samples", r.get("samples") == cfg["samples"], f"{r.get('samples')} (config: {cfg['samples']})")
    fp = r.get("filepath_abs") or r.get("filepath") or ""
    want = ("episodes", cfg["cut"].lower(), "frames")
    name = PureWindowsPath(fp).name.lower() if fp else ""
    target_ok = bool(fp) and _path_tail(fp, 4)[:3] == want and name.rstrip("#") == cfg["frame_prefix"].lower()
    check("output path", target_ok, f"{fp or '(empty)'} (config: .../episodes/{cfg['cut']}/frames/{cfg['frame_prefix']})")
    if cfg.get("blend"):
        bf = snap.get("blend_file") or ""
        if not bf:
            out.append(("warn", "source .blend", "scene is in an unsaved session; cannot confirm it came from "
                                                 f"{cfg['blend']}"))
        else:
            check("source .blend", PureWindowsPath(bf).name.lower() == PureWindowsPath(cfg["blend"]).name.lower(),
                  f"{bf} (config: {cfg['blend']})", bad="warn")
    if cfg.get("picture_lock"):
        state, why = picture_lock_state(snap, cfg.get("shots"))
        if cfg["picture_lock"] == "applied":
            check("picture lock", state == "applied",
                  ("already applied: never run picture_lock.py on this scene. " if state == "applied"
                   else f"expected the locked scene, found {state}: ") + why)
        else:
            check("picture lock", state == "not_applied", f"{state}: {why}")
    return out
