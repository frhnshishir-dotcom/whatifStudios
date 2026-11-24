"""Automated QA. Three layers:
  1. Spec/content  — placeholders, notes, citations, sources, run time, slide count, title style, layout variety.
  2. Geometry      — on the shared element list: bounds, safe margins, text-ink overlap, type floor,
                     WCAG contrast against what is actually behind the text, image resolution.
  3. Files         — .pptx re-opens, every slide's XML parses, morph/transition/animation counts,
                     fonts used, notes present; optional schema validation via the pptx skill.
Rendered checks (HTML overflow/overlap, animation walk-through) come from quality-control/html_qa.cjs.
"""
from __future__ import annotations

import glob
import json
import os
import re
import subprocess
import sys
import zipfile
from pathlib import Path

from lxml import etree
from PIL import Image

from . import backgrounds
from .tokens import contrast

PLACEHOLDER = re.compile(r"\b(lorem|ipsum|TODO|TBD|XXX+|FIXME)\b|\[insert", re.I)
SAFE = 0.4  # inches


def _all_text(el):
    return "".join(t for p in el["paras"] for t, _ in p)


def ink_box(el):
    x, y, w, h = el["box"]
    th = min(el["text_h"], h) if el["fit"] else el["text_h"]
    if el["anchor"] == "middle":
        y = y + (h - th) / 2
    elif el["anchor"] == "bottom":
        y = y + h - th
    return x, y, w, th


def _inter(a, b):
    w = min(a[0] + a[2], b[0] + b[2]) - max(a[0], b[0])
    h = min(a[1] + a[3], b[1] + b[3]) - max(a[1], b[1])
    return w * h if w > 0 and h > 0 else 0.0


def _contains(outer, inner, tol=0.02):
    return (inner[0] >= outer[0] - tol and inner[1] >= outer[1] - tol and
            inner[0] + inner[2] <= outer[0] + outer[2] + tol and inner[1] + inner[3] <= outer[1] + outer[3] + tol)


def geometry(slides_els, ds) -> list[dict]:
    issues = []
    for si, els in enumerate(slides_els, start=1):
        bg = next(e for e in els if e["kind"] == "bg")
        texts = [e for e in els if e["kind"] == "text"]
        for e in els:
            if e["kind"] in ("bg", "scrim", "video") and e.get("bleed", True):
                continue
            x, y, w, h = e["box"]
            if e.get("bleed"):
                continue
            if x < -0.01 or y < -0.01 or x + w > 13.343 or y + h > 7.51:
                issues.append({"level": "FAIL", "slide": si, "check": "bounds", "msg": f"{e['kind']} leaves the slide"})
            elif e["kind"] == "text" and not e.get("decor"):
                ib = ink_box(e)
                if ib[0] < SAFE or ib[1] < SAFE or ib[0] + ib[2] > 13.333 - SAFE or ib[1] + ib[3] > 7.5 - SAFE:
                    issues.append({"level": "WARN", "slide": si, "check": "safe-margin", "msg": f"text within {SAFE}in of the edge: '{_all_text(e)[:40]}'"})
        # text ink overlap
        for i in range(len(texts)):
            for j in range(i + 1, len(texts)):
                a, b = texts[i], texts[j]
                if _inter(ink_box(a), ink_box(b)) > 0.03:
                    issues.append({"level": "FAIL", "slide": si, "check": "overlap",
                                   "msg": f"'{_all_text(a)[:30]}' overlaps '{_all_text(b)[:30]}'"})
        # type floor + contrast
        for t in texts:
            txt = _all_text(t)
            floor = 10 if t["style"] in ("caption", "mono", "eyebrow") else 14
            if t["size"] < floor - 0.05:
                issues.append({"level": "WARN" if t["size"] >= 10 else "FAIL", "slide": si, "check": "type-size",
                               "msg": f"{t['style']} at {t['size']}pt < {floor}pt: '{txt[:40]}'"})
            ib = ink_box(t)
            behind = bg["color"]
            for r in els:
                if r["kind"] == "rect" and r.get("alpha", 1) >= 0.5 and _contains(r["box"], ib):
                    behind = r["fill"]
            on_image = None
            for im in els:
                if im["kind"] == "image" and _inter(im["box"], ib) > 0.05 * ib[2] * ib[3] and im.get("src") and Path(im["src"]).exists():
                    on_image = im
            if on_image is not None:
                scrim = any(e["kind"] == "scrim" for e in els)
                behind = "#202020" if scrim else backgrounds.mean_color(Path(on_image["src"]), ib)
            elif bg.get("image") and behind == bg["color"]:
                behind = backgrounds.mean_color(Path(bg["image"]), ib)
            large = t["size"] >= 24 or (t["size"] >= 18.5 and t["font"]["weight"] in ("semibold", "bold"))
            need = 3.0 if large else 4.5
            cr = contrast(t["color"], behind)
            if cr < need:
                issues.append({"level": "FAIL" if cr < need - 1 else "WARN", "slide": si, "check": "contrast",
                               "msg": f"{cr:.1f}:1 (needs {need}:1) '{txt[:40]}' {t['color']} on {behind}"})
            for _, acc in [r for p in t["paras"] for r in p]:
                if acc and contrast(t["accent"], behind) < 3.0:
                    issues.append({"level": "WARN", "slide": si, "check": "contrast", "msg": f"accent text {contrast(t['accent'], behind):.1f}:1 on {behind}"})
                    break
        # image resolution
        for im in els:
            if im["kind"] == "image" and im.get("src") and Path(im["src"]).exists():
                with Image.open(im["src"]) as pi:
                    iw, ih = pi.size
                w, h = im["box"][2], im["box"][3]
                scale = max(w / iw, h / ih) if im["fit"] == "cover" else min(w / iw, h / ih)
                ppi = 1 / scale
                if ppi < 72:
                    issues.append({"level": "FAIL", "slide": si, "check": "image-res", "msg": f"{Path(im['src']).name}: {ppi:.0f} ppi on slide (blurry when projected)"})
                elif ppi < 110:
                    issues.append({"level": "WARN", "slide": si, "check": "image-res", "msg": f"{Path(im['src']).name}: {ppi:.0f} ppi on slide"})
    return issues


def content(deck, minutes) -> list[dict]:
    issues = []
    m = deck["meta"]
    slides = deck["slides"]
    blob = json.dumps(slides, ensure_ascii=False)
    for hit in set(x.group(0) for x in PLACEHOLDER.finditer(blob)):
        issues.append({"level": "FAIL", "check": "placeholder", "msg": f"placeholder text in deck: '{hit}'"})
    for i, sl in enumerate(slides, start=1):
        if not sl.get("notes", "").strip():
            issues.append({"level": "WARN", "slide": i, "check": "notes", "msg": "no speaker notes"})
        t = sl.get("title", "") if sl["layout"] not in ("closing", "statement", "quote", "image-full", "campaign", "cover") else ""
        if t and t.rstrip().endswith(".") and not t.rstrip().endswith("..."):
            issues.append({"level": "WARN", "slide": i, "check": "title-style", "msg": "title ends with a period"})
    for i in range(2, len(slides)):
        if slides[i]["layout"] == slides[i - 1]["layout"] == slides[i - 2]["layout"] and slides[i]["layout"] not in ("split",):
            issues.append({"level": "WARN", "slide": i + 1, "check": "variety", "msg": f"three '{slides[i]['layout']}' slides in a row"})
    cited = set()
    for sl in slides:
        cited |= set(sl.get("cite", []))
    srcs = deck.get("sources", [])
    for s in srcs:
        if not (s.get("url") or s.get("doi")):
            issues.append({"level": "WARN", "check": "source", "msg": f"source '{s['id']}' has no URL/DOI"})
        if not s.get("verified"):
            issues.append({"level": "WARN", "check": "source", "msg": f"source '{s['id']}' not marked verified (open it and check the figure)"})
        if s["id"] not in cited and s.get("type") != "image":
            issues.append({"level": "WARN", "check": "source", "msg": f"source '{s['id']}' is never cited on a slide"})
    if srcs and not any(sl["layout"] == "references" for sl in slides):
        issues.append({"level": "FAIL" if m.get("academic") else "WARN", "check": "references", "msg": "deck has sources but no references slide"})
    tgt = m.get("duration_min")
    if tgt and not (0.8 * tgt <= minutes <= 1.2 * tgt):
        issues.append({"level": "WARN", "check": "timing", "msg": f"speaker notes run ~{minutes:.1f} min vs target {tgt} min"})
    if m.get("slide_count") and m["slide_count"] != len(slides):
        issues.append({"level": "FAIL", "check": "brief", "msg": f"brief asks for {m['slide_count']} slides, deck has {len(slides)}"})
    for req in m.get("must_cover", []):
        if req.lower() not in blob.lower():
            issues.append({"level": "FAIL", "check": "brief", "msg": f"required topic not found in slides: '{req}'"})
    return issues


def pptx_file(path: Path) -> tuple[list[dict], dict]:
    from pptx import Presentation
    issues, stats = [], {"slides": 0, "morph": 0, "transitions": 0, "animated_slides": 0, "notes": 0, "fonts": set()}
    try:
        prs = Presentation(path)
    except Exception as e:
        return [{"level": "FAIL", "check": "pptx-open", "msg": f"python-pptx cannot open the file: {e}"}], stats
    stats["slides"] = len(prs.slides)
    with zipfile.ZipFile(path) as z:
        for n in z.namelist():
            if n.endswith(".xml") or n.endswith(".rels"):
                try:
                    etree.fromstring(z.read(n))
                except Exception as e:
                    issues.append({"level": "FAIL", "check": "pptx-xml", "msg": f"{n}: {e}"})
        for n in sorted(x for x in z.namelist() if re.match(r"ppt/slides/slide\d+\.xml$", x)):
            x = z.read(n).decode("utf8")
            stats["morph"] += "p159:morph" in x
            stats["transitions"] += "<p:transition" in x
            stats["animated_slides"] += "<p:timing" in x
            stats["fonts"] |= set(re.findall(r'<a:latin typeface="([^"]+)"', x))
    for s in prs.slides:
        if s.has_notes_slide and s.notes_slide.notes_text_frame.text.strip():
            stats["notes"] += 1
    stats["fonts"] = sorted(stats["fonts"])
    # schema validation via the pptx skill when available (cloud sessions)
    for v in glob.glob(os.path.expanduser("~/.claude/skills/**/pptx/scripts/office/validate.py"), recursive=True):
        r = subprocess.run([sys.executable, v, str(path)], capture_output=True, text=True, timeout=300)
        out = (r.stdout + r.stderr).strip()
        stats["validator"] = "pass" if r.returncode == 0 else "fail"
        if r.returncode != 0:
            issues.append({"level": "FAIL", "check": "pptx-schema", "msg": out[-1500:]})
        break
    else:
        stats["validator"] = "not available here"
    return issues, stats


def report(project: str, deck: dict, issues: list[dict], stats: dict, html_rep: dict | None, out: Path, minutes: float) -> tuple[Path, int, int]:
    if html_rep:
        for s in html_rep.get("slides", []):
            for it in s["issues"]:
                issues.append({**it, "slide": s["index"]})
        for e in html_rep.get("errors", []):
            issues.append({"level": "FAIL", "check": "html-runtime", "msg": e})
        a = html_rep.get("animation")
        if a and not a.get("ok"):
            issues.append({"level": "FAIL", "check": "animation", "msg": f"walk-through reached {a['reached']}; unfinished builds {a['hidden_after_build']}"})
    fails = [i for i in issues if i["level"] == "FAIL"]
    warns = [i for i in issues if i["level"] == "WARN"]
    L = [f"# QA report: {deck['meta'].get('title', project)}", "",
         f"**Result: {'PASS' if not fails else 'FAIL'}** — {len(fails)} fail, {len(warns)} warn · {len(deck['slides'])} slides · ~{minutes:.1f} min of notes", ""]
    L += ["## Files", "", f"- PPTX: {stats.get('slides')} slides, {stats.get('transitions')} with transitions ({stats.get('morph')} Morph), "
          f"{stats.get('animated_slides')} with entrance builds, {stats.get('notes')} with notes",
          f"- Fonts in PPTX: {', '.join(stats.get('fonts', []))}", f"- OOXML schema validator: {stats.get('validator')}"]
    if html_rep:
        a = html_rep.get("animation") or {}
        L += [f"- HTML: {len(html_rep.get('slides', []))} slides rendered, runtime errors: {len(html_rep.get('errors', []))}, "
              f"animated walk-through: {'OK' if a.get('ok') else 'not run' if not a else 'FAILED'}, View Transitions (morph) supported: {html_rep.get('viewTransitions')}"]
    L += ["", "## Issues", ""]
    if not issues:
        L.append("None found by the automated checks.")
    for lvl in ("FAIL", "WARN"):
        for i in issues:
            if i["level"] == lvl:
                L.append(f"- **{lvl}** {('slide ' + str(i['slide'])) if i.get('slide') else 'deck'} · `{i['check']}` · {i['msg']}")
    L += ["", "## Human review (required — automated checks cannot judge these)", "",
          "Open `qa/contact_html.png` and `qa/contact_pptx.png`, then score 1–5 against `quality-control/RUBRIC.md`:", "",
          "| Criterion | Score | Note |", "|---|---|---|"] + [f"| {c} | | |" for c in (
              "Visual design", "Storytelling", "Content accuracy", "Academic relevance", "Typography", "Visual assets",
              "Motion design", "Consistency", "Technical execution", "Overall experience")]
    out.mkdir(parents=True, exist_ok=True)
    p = out / "report.md"
    p.write_text("\n".join(L) + "\n", encoding="utf-8")
    (out / "report.json").write_text(json.dumps({"fails": len(fails), "warns": len(warns), "issues": issues, "stats": stats}, indent=1, default=str))
    return p, len(fails), len(warns)
