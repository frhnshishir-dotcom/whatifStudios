"""Citations. Sources live in deck["sources"] (or projects/<p>/sources.json) as:
  {"id": "wb2026", "author": "World Bank", "year": 2026, "title": "Individuals using the Internet (% of population)",
   "publisher": "World Development Indicators", "url": "https://...", "accessed": "2026-11-24",
   "type": "dataset|article|report|web|book|image", "license": "CC BY 4.0", "doi": "", "verified": true}
APA 7 is the default; in-text form is (Author, Year)."""
from __future__ import annotations


def _authors(s: dict) -> str:
    a = s.get("author") or s.get("publisher") or "Anon."
    if isinstance(a, list):
        if len(a) == 1:
            return a[0]
        if len(a) == 2:
            return f"{a[0]} & {a[1]}"
        return ", ".join(a[:-1]) + f", & {a[-1]}"
    return a


def in_text(s: dict) -> str:
    a = s.get("author") or s.get("publisher") or "Anon."
    if isinstance(a, list):
        a = a[0].split(",")[0] + (" et al." if len(s["author"]) > 2 else (f" & {s['author'][1].split(',')[0]}" if len(s["author"]) == 2 else ""))
    return f"{a}, {s.get('year', 'n.d.')}"


def apa(s: dict) -> str:
    parts = [f"{_authors(s)} ({s.get('year', 'n.d.')})."]
    t = s.get("title", "")
    kind = s.get("type", "web")
    if kind == "dataset":
        t += " [Data set]"
    elif kind == "image":
        t += " [Photograph]"
    parts.append(f"{t}.")
    if s.get("container"):
        parts.append(f"{s['container']}.")
    if s.get("publisher") and s.get("publisher") != s.get("author"):
        parts.append(f"{s['publisher']}.")
    if s.get("doi"):
        parts.append(f"https://doi.org/{s['doi']}")
    elif s.get("url"):
        acc = f"Retrieved {s['accessed']}, from " if s.get("accessed") and kind in ("dataset", "web") else ""
        parts.append(f"{acc}{s['url']}")
    if s.get("license"):
        parts.append(f"({s['license']})")
    return " ".join(parts)
