"""Font registry: one place that knows, for every (family, weight) a design system may ask for,
  * the font file used to MEASURE text (so layout fitting matches what renders),
  * the family name + bold flag written into the .pptx,
  * the CSS @font-face used by the HTML deck.

Two modes:
  brand    -> vendored OFL fonts (Inter, Inter Display, Instrument Serif, JetBrains Mono).
              Looks best. The presenting PC needs the fonts installed (fonts/install_fonts.ps1),
              otherwise PowerPoint substitutes. PDF and HTML exports embed them, so they are always right.
  portable -> fonts that ship with Microsoft Office (Calibri, Cambria, Courier New). Use for a .pptx that
              will be opened on a school/university PC you don't control. Measured with the metric-compatible
              Carlito / Caladea / Liberation Mono, so overflow checks stay trustworthy.
"""
from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

STUDIO = Path(__file__).resolve().parent.parent
FONT_DIR = STUDIO / "assets" / "fonts"

WEIGHTS = {"thin": 100, "light": 300, "regular": 400, "medium": 500, "semibold": 600, "bold": 700}


@dataclass(frozen=True)
class FontFace:
    family: str          # logical family (CSS font-family)
    weight: str          # light / regular / medium / semibold / bold
    file: Path           # file used for measurement (and @font-face in HTML)
    pptx_name: str       # typeface written into the pptx
    pptx_bold: bool      # bold flag in the pptx run

    @property
    def css_weight(self) -> int:
        return WEIGHTS[self.weight]


# family -> weight -> (file name, pptx family name, pptx bold)
_BRAND = {
    "Inter": {
        "light": ("Inter-Light.otf", "Inter Light", False),
        "regular": ("Inter-Regular.otf", "Inter", False),
        "medium": ("Inter-Medium.otf", "Inter Medium", False),
        "semibold": ("Inter-SemiBold.otf", "Inter SemiBold", False),
        "bold": ("Inter-Bold.otf", "Inter", True),
    },
    "Inter Display": {
        "light": ("InterDisplay-Light.otf", "Inter Display Light", False),
        "regular": ("InterDisplay-Regular.otf", "Inter Display", False),
        "medium": ("InterDisplay-Medium.otf", "Inter Display Medium", False),
        "semibold": ("InterDisplay-SemiBold.otf", "Inter Display SemiBold", False),
        "bold": ("InterDisplay-Bold.otf", "Inter Display", True),
    },
    "Instrument Serif": {
        "regular": ("InstrumentSerif-Regular.ttf", "Instrument Serif", False),
        "italic": ("InstrumentSerif-Italic.ttf", "Instrument Serif", False),
    },
    "JetBrains Mono": {
        "regular": ("JetBrainsMono-Regular.ttf", "JetBrains Mono", False),
        "medium": ("JetBrainsMono-Medium.ttf", "JetBrains Mono Medium", False),
    },
}

# Metric-compatible stand-ins for Office fonts (Linux: fonts-crosextra-*, fonts-liberation).
_SYSTEM_CANDIDATES = {
    "Carlito-Regular": ["/usr/share/fonts/truetype/crosextra/Carlito-Regular.ttf", "C:/Windows/Fonts/calibri.ttf"],
    "Carlito-Bold": ["/usr/share/fonts/truetype/crosextra/Carlito-Bold.ttf", "C:/Windows/Fonts/calibrib.ttf"],
    "Caladea-Regular": ["/usr/share/fonts/truetype/crosextra/Caladea-Regular.ttf", "C:/Windows/Fonts/cambria.ttc"],
    "Caladea-Bold": ["/usr/share/fonts/truetype/crosextra/Caladea-Bold.ttf", "C:/Windows/Fonts/cambriab.ttf"],
    "LiberationMono-Regular": ["/usr/share/fonts/truetype/liberation/LiberationMono-Regular.ttf", "C:/Windows/Fonts/cour.ttf"],
}


def _system(name: str) -> Path:
    for c in _SYSTEM_CANDIDATES[name]:
        if os.path.exists(c):
            return Path(c)
    # fall back to a vendored font so measuring never crashes (QA will warn that metrics are approximate)
    return FONT_DIR / "Inter-Regular.otf"


def _portable(family: str, weight: str) -> FontFace:
    heavy = WEIGHTS.get(weight, 400) >= 600
    if family == "Instrument Serif":
        f = _system("Caladea-Bold" if heavy else "Caladea-Regular")
        return FontFace(family, weight, f, "Cambria", heavy)
    if family == "JetBrains Mono":
        return FontFace(family, weight, _system("LiberationMono-Regular"), "Courier New", False)
    f = _system("Carlito-Bold" if heavy else "Carlito-Regular")
    return FontFace(family, weight, f, "Calibri", heavy)


def resolve(family: str, weight: str = "regular", mode: str = "brand") -> FontFace:
    if mode == "portable":
        return _portable(family, weight)
    fam = _BRAND.get(family)
    if fam is None:
        raise KeyError(f"Font family '{family}' is not in the registry (engine/fonts.py). Known: {sorted(_BRAND)}")
    if weight not in fam:  # nearest available weight
        target = WEIGHTS.get(weight, 400)
        weight = min(fam, key=lambda w: abs(WEIGHTS.get(w, 400) - target))
    file, name, bold = fam[weight]
    return FontFace(family, weight, FONT_DIR / file, name, bold)


def css_font_faces(used: set[tuple[str, str]], rel_prefix: str = "fonts/") -> str:
    """@font-face rules for the faces a deck uses (HTML always uses brand fonts)."""
    out = []
    for family, weight in sorted(used):
        f = resolve(family, weight, "brand")
        style = "italic" if weight == "italic" else "normal"
        w = 400 if weight == "italic" else f.css_weight
        fmt = "opentype" if f.file.suffix == ".otf" else "truetype"
        out.append(
            f"@font-face{{font-family:'{family}';font-style:{style};font-weight:{w};font-display:block;"
            f"src:url('{rel_prefix}{f.file.name}') format('{fmt}');}}"
        )
    return "\n".join(out)
