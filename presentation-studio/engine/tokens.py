"""Design-system loader. A design system is a JSON file in design-systems/ (see design-systems/README.md).
Projects can override any token with deck["overrides"] (deep-merged)."""
from __future__ import annotations

import copy
import json
from dataclasses import dataclass
from pathlib import Path

from . import fonts

STUDIO = Path(__file__).resolve().parent.parent
DS_DIR = STUDIO / "design-systems"


def deep_merge(a: dict, b: dict) -> dict:
    out = copy.deepcopy(a)
    for k, v in (b or {}).items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = deep_merge(out[k], v)
        else:
            out[k] = copy.deepcopy(v)
    return out


def list_systems() -> list[str]:
    return sorted(p.stem for p in DS_DIR.glob("*.json"))


def load(name_or_path: str, overrides: dict | None = None) -> dict:
    p = Path(name_or_path)
    if not p.suffix:
        p = DS_DIR / f"{name_or_path}.json"
    ds = json.loads(p.read_text(encoding="utf-8"))
    return deep_merge(ds, overrides or {})


def hex_to_rgb(h: str) -> tuple[int, int, int]:
    h = h.lstrip("#")
    return int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)


def color(ds: dict, c: str | None) -> str:
    """Token name ('accent') or literal '#RRGGBB' -> '#RRGGBB'."""
    if c is None:
        return ds["colors"]["text"]
    if c.startswith("#"):
        return c.upper()
    return ds["colors"][c].upper()


@dataclass
class Style:
    name: str
    face: fonts.FontFace
    size: float
    min_size: float
    line_height: float
    tracking: float  # em
    upper: bool
    italic: bool
    color: str       # resolved hex

    @property
    def css_family(self) -> str:
        return self.face.family


def style(ds: dict, name: str, mode: str = "brand", **over) -> Style:
    t = dict(ds["type"][name])
    t.update({k: v for k, v in over.items() if v is not None})
    role = ds["fonts"][t.get("font", "body")]
    family = role["family"]
    weight = t.get("weight", role.get("weight", "regular"))
    italic = bool(t.get("italic", False))
    face = fonts.resolve(family, "italic" if (italic and family == "Instrument Serif") else weight, mode)
    return Style(
        name=name, face=face, size=float(t["size"]), min_size=float(t.get("min", t["size"])),
        line_height=float(t.get("lh", 1.2)), tracking=float(t.get("track", 0.0)),
        upper=bool(t.get("upper", False)), italic=italic, color=color(ds, t.get("color", "text")),
    )


def luminance(hex_color: str) -> float:
    def ch(c):
        c = c / 255
        return c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4
    r, g, b = hex_to_rgb(hex_color)
    return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b)


def contrast(a: str, b: str) -> float:
    la, lb = sorted((luminance(a), luminance(b)), reverse=True)
    return (la + 0.05) / (lb + 0.05)
