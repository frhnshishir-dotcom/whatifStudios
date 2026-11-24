"""Speaker script (Markdown) + timing check. ~130 spoken words per minute is a calm presenting pace."""
from __future__ import annotations

from pathlib import Path

from . import refs
from .layouts import plain

WPM = 130


def slide_title(sl: dict) -> str:
    return plain(sl.get("title") or sl.get("text") or sl.get("value") or sl.get("quote") or sl["layout"])


def script(deck: dict) -> tuple[str, float]:
    m = deck["meta"]
    lines = [f"# Speaker script: {m.get('title', '')}", ""]
    if m.get("author") or m.get("course"):
        lines += [" · ".join(x for x in (m.get("author"), m.get("course"), m.get("date")) if x), ""]
    total = 0.0
    rows = []
    for i, sl in enumerate(deck["slides"], start=1):
        n = sl.get("notes", "").strip()
        words = len(n.split())
        sec = sl.get("seconds") or max(8, words / WPM * 60)
        total += sec
        rows.append((i, slide_title(sl), sec))
        lines += [f"## {i:02d} · {slide_title(sl)}", f"*{sl['layout']} · ~{sec:.0f} s · {words} words*", "", n or "_(no notes — add them)_", ""]
    target = m.get("duration_min")
    head = [f"**Estimated run time:** {total / 60:.1f} min" + (f" (target {target} min)" if target else ""), "",
            "| # | Slide | Time |", "|---|---|---|"] + [f"| {i} | {t} | {s:.0f} s |" for i, t, s in rows] + [""]
    if deck.get("sources"):
        lines += ["## Sources", ""] + [f"- {refs.apa(s)}" for s in deck["sources"]]
    return "\n".join(lines[:2] + head + lines[2:]) + "\n", total / 60


def write(deck: dict, out: Path) -> tuple[Path, float]:
    md, minutes = script(deck)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(md, encoding="utf-8")
    return out, minutes
