"""
WhatIfStudio pipeline - shared helpers: cut config, frame-name parsing, atomic JSON writes.
Plain Python 3.9+ (stdlib only). No bpy, so it runs outside Blender, on Windows and in CI.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import tempfile
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
AUDIO_MODES = ("forbidden", "required", "optional")
REQUIRED = {"cut": str, "frame_start": int, "frame_end": int, "fps": int, "width": int, "height": int, "audio": str}
DEFAULTS = {
    "frame_prefix": "frame_",
    "color_mode": "RGB",
    "black_threshold": 4.0,     # mean luma (0-255) below this = black frame
    "dark_ranges": [],          # [[a, b], ...] frames allowed to be dark (intentional fades)
    "min_size_ratio": 0.4,      # file smaller than this x the local median = undersized
}
# Keys that only tune validation, encoding or tooling. Changing them does not invalidate rendered frames.
NON_RENDER_KEYS = {"black_threshold", "dark_ranges", "min_size_ratio", "audio", "audio_file", "notes",
                   "output_name", "crf", "preset", "ffmpeg_dir", "shots", "max_chunk", "est_frame_mb",
                   "picture_lock", "required_files"}
IGNORED_FILES = {"thumbs.db", "desktop.ini", ".ds_store"}


class ConfigError(ValueError):
    pass


class ToolError(RuntimeError):
    pass


@dataclass
class Issue:
    code: str
    severity: str            # "error" | "warning"
    frame: int | None = None
    path: str | None = None
    detail: str = ""


def validate_config(data: dict) -> dict:
    cfg = {**DEFAULTS, **data}
    for k, t in REQUIRED.items():
        if k not in cfg:
            raise ConfigError(f"missing key {k!r}")
        if not isinstance(cfg[k], t) or isinstance(cfg[k], bool):
            raise ConfigError(f"{k!r} must be {t.__name__}, got {cfg[k]!r}")
    if cfg["frame_start"] < 0 or cfg["frame_end"] < cfg["frame_start"]:
        raise ConfigError(f"bad frame range {cfg['frame_start']}-{cfg['frame_end']}")
    if cfg["fps"] <= 0:
        raise ConfigError("fps must be > 0")
    for k in ("width", "height"):
        if cfg[k] <= 0 or cfg[k] % 2:
            raise ConfigError(f"{k} must be positive and even (H.264 yuv420p), got {cfg[k]}")
    if cfg["audio"] not in AUDIO_MODES:
        raise ConfigError(f"audio must be one of {AUDIO_MODES}, got {cfg['audio']!r}")
    if not re.fullmatch(r"[A-Za-z0-9_\-]+", cfg["cut"]):
        raise ConfigError(f"cut must be a plain folder name, got {cfg['cut']!r}")
    for r in cfg["dark_ranges"]:
        if not (isinstance(r, list) and len(r) == 2 and all(isinstance(v, int) for v in r) and r[0] <= r[1]):
            raise ConfigError(f"dark_ranges entries must be [start, end], got {r!r}")
    return cfg


def load_config(path) -> dict:
    try:
        data = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as e:
        raise ConfigError(f"cannot read config {path}: {e}") from e
    if not isinstance(data, dict):
        raise ConfigError("config must be a JSON object")
    return validate_config(data)


def config_hash(cfg: dict) -> str:
    """Hash of everything that affects rendered frames (validation-only keys excluded)."""
    render = {k: v for k, v in sorted(cfg.items()) if k not in NON_RENDER_KEYS}
    return hashlib.sha256(json.dumps(render, sort_keys=True).encode("utf-8")).hexdigest()[:16]


def cut_dir(cfg: dict, root=ROOT) -> Path:
    return Path(root) / "episodes" / cfg["cut"]


def frame_count(cfg: dict) -> int:
    return cfg["frame_end"] - cfg["frame_start"] + 1


def find_tool(name: str, cfg: dict | None = None) -> str:
    """ffmpeg / ffprobe: cfg["ffmpeg_dir"] first, then PATH. A shell opened before a PATH change won't see it,
    so on Windows set ffmpeg_dir in the config instead of relying on PATH."""
    d = (cfg or {}).get("ffmpeg_dir")
    if d:
        for cand in (Path(d) / name, Path(d) / f"{name}.exe"):
            if cand.is_file():
                return str(cand)
        raise ToolError(f"{name} not found in ffmpeg_dir {d}")
    found = shutil.which(name)
    if not found:
        raise ToolError(f"{name} not found on PATH (set ffmpeg_dir in the cut config)")
    return found


def scan_frames(frames_dir, prefix: str = "frame_"):
    """Return ({frame_number: [paths]}, [stray paths]). Several paths for one number = duplicate."""
    pat = re.compile(rf"^{re.escape(prefix)}(\d+)\.png$", re.IGNORECASE)
    frames, strays = {}, []
    for p in sorted(Path(frames_dir).iterdir()):
        if not p.is_file() or p.name.lower() in IGNORED_FILES:
            continue
        m = pat.match(p.name)
        if m:
            frames.setdefault(int(m.group(1)), []).append(p)
        else:
            strays.append(p)
    return frames, strays


def compress_ranges(nums) -> str:
    """[1, 2, 3, 7, 9, 10] -> '1-3, 7, 9-10'"""
    nums = sorted(set(nums))
    out, i = [], 0
    while i < len(nums):
        j = i
        while j + 1 < len(nums) and nums[j + 1] == nums[j] + 1:
            j += 1
        out.append(str(nums[i]) if i == j else f"{nums[i]}-{nums[j]}")
        i = j + 1
    return ", ".join(out)


def atomic_write_json(path, data) -> None:
    """Write JSON so a crash leaves either the old file or the new one, never half a file."""
    path = Path(path)
    text = json.dumps(data, indent=2, sort_keys=True)     # serialise first: a bad value touches nothing
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=path.name + ".", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(text)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
