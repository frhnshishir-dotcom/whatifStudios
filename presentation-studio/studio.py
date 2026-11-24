#!/usr/bin/env python3
"""Presentation Studio CLI.

  python studio.py systems                         list design systems
  python studio.py templates                       list starter templates
  python studio.py new <project> [--template keynote] [--system monolith]
  python studio.py build <project> [--fonts brand|portable] [--fast]
  python studio.py qa <project>                    re-run QA on the last build
  python studio.py bg <system> <kind> <out.jpg>    one procedural background
  python studio.py fonts                           where the fonts are + how to install them
  python studio.py vendor                          rebuild the Three.js viewer bundle (needs node/npm)

A project is projects/<project>/deck.json (+ assets/, research/). Output: exports/<project>/.
"""
from __future__ import annotations

import argparse
import json
import shutil
import sys
import time
from pathlib import Path

STUDIO = Path(__file__).resolve().parent
sys.path.insert(0, str(STUDIO))

from engine import export, html_builder, layouts, notes, pptx_builder, qa, refs, tokens  # noqa: E402

PROJECTS = STUDIO / "projects"
EXPORTS = STUDIO / "exports"
TEMPLATES = STUDIO / "templates"


def load_deck(project: str) -> tuple[dict, Path]:
    d = PROJECTS / project
    deck = json.loads((d / "deck.json").read_text(encoding="utf-8"))
    src = d / "sources.json"
    if src.exists():
        deck.setdefault("sources", [])
        known = {s["id"] for s in deck["sources"]}
        deck["sources"] += [s for s in json.loads(src.read_text(encoding="utf-8")) if s["id"] not in known]
    return deck, d


def cmd_build(a):
    t0 = time.time()
    deck, pdir = load_deck(a.project)
    ds = tokens.load(deck.get("design_system", "monolith"), deck.get("overrides"))
    out = EXPORTS / a.project
    build_dir = out / "_build"
    qa_dir = out / "qa"
    for d in (out, build_dir, qa_dir):
        d.mkdir(parents=True, exist_ok=True)
    name = deck["meta"].get("file_name") or a.project
    print(f"▸ {deck['meta'].get('title')}  [{ds['name']} · fonts={a.fonts} · {len(deck['slides'])} slides]")

    # 1. layout (shared by every output)
    def lay(mode):
        ctx = layouts.Ctx(deck, ds, mode, pdir, build_dir)
        return [layouts.build_slide(ctx, sl, i) for i, sl in enumerate(deck["slides"], start=1)], ctx.issues
    els_html, issues_html = lay("brand")
    els_pptx, issues = lay(a.fonts) if a.fonts != "brand" else (els_html, issues_html)
    (build_dir / "elements.json").write_text(json.dumps(els_pptx, indent=1, default=str))
    print(f"  layout ✓ ({len(issues)} layout issues)")

    # 2. HTML deck
    web = out / "web"
    index = html_builder.build(deck, ds, els_html, web)
    print(f"  html   ✓ {index.relative_to(STUDIO)}")

    # 3. render + check HTML (screenshots, 3D posters, PDF)
    pdf = out / f"{name}.pdf"
    html_rep = None
    if not a.no_render:
        html_rep = export.html_qa(index, qa_dir / "html", pdf, build_dir / "posters", animate=not a.fast)
        if html_rep:
            for p in html_rep.get("posters", []):
                for els in (els_pptx, els_html):
                    for el in els[p["slide"] - 1]:
                        if el["kind"] == "viewer" and not el.get("poster"):
                            el["poster"] = p["path"]
            shots = sorted((qa_dir / "html").glob("html-*.png"))
            sd = out / "slides"
            sd.mkdir(exist_ok=True)
            for s in shots:
                shutil.copy2(s, sd / s.name.replace("html-", "slide-"))
            export.contact_sheet(shots, qa_dir / "contact_html.png", label=f"HTML · {deck['meta'].get('title')}")
            print(f"  render ✓ {len(shots)} slide PNGs, PDF {'✓' if pdf.exists() else '✗'}")

    # 4. PPTX
    pptx = pptx_builder.build(deck, ds, els_pptx, out / f"{name}.pptx", a.fonts, build_dir, issues)
    print(f"  pptx   ✓ {pptx.relative_to(STUDIO)}")

    # 5. speaker script + sources
    sp, minutes = notes.write(deck, out / f"{name}_speaker_script.md")
    if deck.get("sources"):
        (out / "sources.md").write_text("# Sources (APA 7)\n\n" + "\n".join(f"- {refs.apa(s)}" for s in deck["sources"]) + "\n", encoding="utf-8")
    print(f"  notes  ✓ ~{minutes:.1f} min")

    # 6. PPTX visual proof + QA
    if not a.no_render:
        rp = export.pptx_to_pdf(pptx, qa_dir / "pptx")
        if rp:
            pngs = export.pdf_to_pngs(rp, qa_dir / "pptx", 1600, "pptx")
            export.contact_sheet(pngs, qa_dir / "contact_pptx.png", label=f"PPTX (LibreOffice render) · {deck['meta'].get('title')}")
            if not pdf.exists():
                shutil.copy2(rp, pdf)
            print(f"  pptx render ✓ {len(pngs)} pages")
    fi, stats = qa.pptx_file(pptx)
    allissues = issues + qa.geometry(els_pptx, ds) + qa.content(deck, minutes) + fi
    if a.fonts == "brand":
        allissues.append({"level": "WARN", "check": "fonts", "msg": "brand fonts: install assets/fonts on the presenting PC, or rebuild with --fonts portable (PDF/HTML are unaffected)"})
    rp, nf, nw = qa.report(a.project, deck, allissues, stats, html_rep, qa_dir, minutes)
    print(f"  qa     {'✓ PASS' if not nf else '✗ FAIL'} ({nf} fail, {nw} warn) → {rp.relative_to(STUDIO)}")
    print(f"done in {time.time() - t0:.0f}s → {out.relative_to(STUDIO)}/")
    return 1 if nf else 0


def cmd_new(a):
    d = PROJECTS / a.project
    if d.exists():
        sys.exit(f"{d} already exists — not overwriting")
    tpl = json.loads((TEMPLATES / f"{a.template}.json").read_text(encoding="utf-8"))
    if a.system:
        tpl["design_system"] = a.system
    (d / "assets").mkdir(parents=True)
    (d / "research").mkdir()
    (d / "deck.json").write_text(json.dumps(tpl, indent=1, ensure_ascii=False), encoding="utf-8")
    (d / "brief.md").write_text((STUDIO / "research" / "BRIEF_TEMPLATE.md").read_text(encoding="utf-8"), encoding="utf-8")
    print(f"created {d.relative_to(STUDIO)} from template '{a.template}' ({tpl.get('design_system')})")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("systems")
    sub.add_parser("templates")
    sub.add_parser("fonts")
    sub.add_parser("vendor")
    n = sub.add_parser("new"); n.add_argument("project"); n.add_argument("--template", default="keynote"); n.add_argument("--system")
    b = sub.add_parser("build"); b.add_argument("project"); b.add_argument("--fonts", choices=["brand", "portable"], default="brand")
    b.add_argument("--fast", action="store_true", help="skip the animated walk-through"); b.add_argument("--no-render", action="store_true")
    q = sub.add_parser("qa"); q.add_argument("project")
    g = sub.add_parser("bg"); g.add_argument("system"); g.add_argument("kind"); g.add_argument("out"); g.add_argument("--seed", type=int, default=3)
    a = ap.parse_args()
    if a.cmd == "systems":
        for s in tokens.list_systems():
            ds = tokens.load(s)
            print(f"{s:10} {ds['mode']:5} {ds['description']}")
    elif a.cmd == "templates":
        for t in sorted(TEMPLATES.glob("*.json")):
            j = json.loads(t.read_text(encoding="utf-8"))
            print(f"{t.stem:16} {len(j['slides']):2} slides  {j['meta'].get('template_note', '')}")
    elif a.cmd == "fonts":
        print(f"Fonts: {STUDIO / 'assets' / 'fonts'}\nWindows: right-click each .otf/.ttf → 'Install for all users', or run\n"
              f"  powershell -ExecutionPolicy Bypass -File \"{STUDIO / 'assets' / 'fonts' / 'install_fonts.ps1'}\"")
    elif a.cmd == "vendor":
        print("See 3d-assets/web/README.md (npm i three@0.170.0 esbuild; npx esbuild ... --format=iife)")
    elif a.cmd == "new":
        cmd_new(a)
    elif a.cmd == "build":
        a.no_render = getattr(a, "no_render", False)
        sys.exit(cmd_build(a))
    elif a.cmd == "qa":
        a.fonts, a.fast, a.no_render = "brand", True, False
        sys.exit(cmd_build(a))
    elif a.cmd == "bg":
        from engine import backgrounds
        ds = tokens.load(a.system)
        backgrounds.render(a.kind, ds["colors"], a.seed).save(a.out, quality=92)
        print(a.out)


if __name__ == "__main__":
    main()
