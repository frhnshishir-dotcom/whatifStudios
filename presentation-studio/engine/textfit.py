"""Measure and fit text with the real font files, so a layout knows before rendering whether
copy fits its box. Units: points for type, inches for boxes (1 in = 72 pt)."""
from __future__ import annotations

from dataclasses import dataclass
from functools import lru_cache

from PIL import ImageFont

from .fonts import FontFace

SAFETY = 0.965  # PowerPoint/LibreOffice/Chrome wrap slightly differently: keep 3.5 % slack


@lru_cache(maxsize=256)
def _font(path: str):
    return ImageFont.truetype(path, 1000)  # measure at 1000 units, scale linearly


def text_width_pt(text: str, face: FontFace, size_pt: float, tracking: float = 0.0) -> float:
    f = _font(str(face.file))
    w = f.getlength(text) / 1000.0 * size_pt
    if tracking and len(text) > 1:
        w += tracking * size_pt * (len(text) - 1)
    return w


@dataclass
class Fit:
    size: float
    lines: int
    height_in: float
    fits: bool
    longest_word_fits: bool
    wrapped: list[str]


def wrap(text: str, face: FontFace, size: float, width_pt: float, tracking: float = 0.0) -> list[str]:
    lines: list[str] = []
    for para in text.split("\n"):
        words = para.split(" ")
        cur = ""
        for w in words:
            trial = (cur + " " + w).strip() if cur else w
            if text_width_pt(trial, face, size, tracking) <= width_pt or not cur:
                cur = trial
            else:
                lines.append(cur)
                cur = w
        lines.append(cur)
    return lines


def measure(paragraphs: list[str], face: FontFace, size: float, box_w_in: float,
            line_height: float, tracking: float = 0.0, para_space: float = 0.0, indent_in: float = 0.0) -> Fit:
    width_pt = (box_w_in - indent_in) * 72 * SAFETY
    wrapped: list[str] = []
    n_lines = 0
    word_ok = True
    for p in paragraphs:
        ls = wrap(p, face, size, width_pt, tracking)
        wrapped += ls
        n_lines += len(ls)
        for w in p.split():
            if text_width_pt(w, face, size, tracking) > width_pt:
                word_ok = False
    h_pt = n_lines * size * line_height + max(0, len(paragraphs) - 1) * para_space * size
    return Fit(size, n_lines, h_pt / 72, True, word_ok, wrapped)


def fit(paragraphs: list[str], face: FontFace, size: float, box_w_in: float, box_h_in: float,
        line_height: float, tracking: float = 0.0, min_size: float | None = None,
        para_space: float = 0.0, indent_in: float = 0.0, max_lines: int | None = None) -> Fit:
    """Largest size <= `size` (down to `min_size`) at which the text fits the box.
    Returns fits=False if even min_size overflows: the caller must cut copy or split the slide."""
    min_size = min_size or size
    s = size
    while True:
        m = measure(paragraphs, face, s, box_w_in, line_height, tracking, para_space, indent_in)
        ok = m.height_in <= box_h_in + 1e-6 and m.longest_word_fits and (max_lines is None or m.lines <= max_lines)
        if ok:
            return m
        nxt = round(s * 0.96, 1)
        if nxt < min_size:
            m.fits = False
            return m
        s = nxt
