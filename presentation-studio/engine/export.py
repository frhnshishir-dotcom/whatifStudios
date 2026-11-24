"""Exports: PPTX -> PDF (LibreOffice), PDF -> PNG (PyMuPDF), HTML -> PDF/PNG (Playwright or Chrome/Edge),
contact sheets. Every function returns None (and says why) instead of crashing when a tool is missing."""
from __future__ import annotations

import glob
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

STUDIO = Path(__file__).resolve().parent.parent

SOFFICE_CANDIDATES = [
    os.environ.get("STUDIO_SOFFICE", ""),
    r"C:\Program Files\LibreOffice\program\soffice.exe",
    r"C:\Program Files (x86)\LibreOffice\program\soffice.exe",
    "/Applications/LibreOffice.app/Contents/MacOS/soffice",
]
BROWSER_CANDIDATES = [
    os.environ.get("STUDIO_BROWSER", ""),
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    "/opt/pw-browsers/chromium",
]


def find_soffice() -> str | None:
    w = shutil.which("soffice") or shutil.which("libreoffice")
    return w or next((c for c in SOFFICE_CANDIDATES if c and os.path.exists(c)), None)


def find_browser() -> str | None:
    for n in ("google-chrome", "chromium", "chromium-browser", "msedge"):
        if shutil.which(n):
            return shutil.which(n)
    return next((c for c in BROWSER_CANDIDATES if c and os.path.exists(c)), None)


def _skill_soffice():
    """Cloud sessions ship a sandbox-safe LibreOffice wrapper with the pptx skill; use it when present."""
    for p in glob.glob(os.path.expanduser("~/.claude/skills/**/pptx/scripts/office/soffice.py"), recursive=True):
        sys.path.insert(0, str(Path(p).parent.parent))
        try:
            from office.soffice import run_soffice  # type: ignore
            return run_soffice
        except Exception:
            continue
    return None


def pptx_to_pdf(pptx: Path, out_dir: Path) -> Path | None:
    exe = find_soffice()
    if not exe:
        print("  ! LibreOffice not found: skipping PPTX->PDF (install LibreOffice or set STUDIO_SOFFICE)")
        return None
    out_dir.mkdir(parents=True, exist_ok=True)
    args = ["--headless", "--convert-to", "pdf", "--outdir", str(out_dir), str(pptx)]
    runner = _skill_soffice()
    try:
        if runner:
            runner(args, capture_output=True, timeout=300)
        else:
            with tempfile.TemporaryDirectory(prefix="lo_profile_") as prof:
                env = dict(os.environ, SAL_USE_VCLPLUGIN=os.environ.get("SAL_USE_VCLPLUGIN", "svp") if os.name != "nt" else "")
                subprocess.run([exe, f"-env:UserInstallation={Path(prof).as_uri()}"] + args, capture_output=True, timeout=300, env=env)
    except subprocess.TimeoutExpired:
        print("  ! LibreOffice timed out")
        return None
    pdf = out_dir / (pptx.stem + ".pdf")
    return pdf if pdf.exists() else None


def pdf_to_pngs(pdf: Path, out_dir: Path, width_px: int = 1920, prefix: str = "slide") -> list[Path]:
    import pymupdf
    out_dir.mkdir(parents=True, exist_ok=True)
    for old in out_dir.glob(f"{prefix}-*.png"):
        old.unlink()
    doc = pymupdf.open(pdf)
    out = []
    for i, page in enumerate(doc, start=1):
        zoom = width_px / page.rect.width
        pix = page.get_pixmap(matrix=pymupdf.Matrix(zoom, zoom), alpha=False)
        p = out_dir / f"{prefix}-{i:02d}.png"
        pix.save(p)
        out.append(p)
    return out


def node_playwright_ok() -> bool:
    if not shutil.which("node"):
        return False
    r = subprocess.run(["node", "-e", "require('playwright')"], capture_output=True)
    return r.returncode == 0


def html_qa(index: Path, out_dir: Path, pdf: Path | None, posters: Path | None, animate: bool = True) -> dict | None:
    """Runs quality-control/html_qa.mjs (Playwright): per-slide screenshots, rendered overflow/overlap checks,
    animation walk-through, PDF, 3D posters."""
    if not node_playwright_ok():
        print("  ! Node Playwright not available: HTML screenshots/QA skipped (falling back to browser print for PDF)")
        if pdf:
            html_to_pdf_cli(index, pdf)
        return None
    args = ["node", str(STUDIO / "quality-control" / "html_qa.cjs"), str(index), str(out_dir)]
    if pdf:
        args += ["--pdf", str(pdf)]
    if posters:
        args += ["--posters", str(posters)]
    if not animate:
        args += ["--no-animate"]
    r = subprocess.run(args, capture_output=True, text=True, timeout=900)
    if r.returncode != 0:
        print(r.stdout[-2000:], r.stderr[-2000:])
        return None
    rep = out_dir / "html_qa.json"
    return json.loads(rep.read_text()) if rep.exists() else None


def html_to_pdf_cli(index: Path, pdf: Path) -> Path | None:
    b = find_browser()
    if not b:
        print("  ! No Chrome/Edge found for HTML->PDF")
        return None
    subprocess.run([b, "--headless=new", "--no-sandbox", "--disable-gpu", "--no-pdf-header-footer",
                    "--virtual-time-budget=8000", f"--print-to-pdf={pdf}", index.resolve().as_uri()],
                   capture_output=True, timeout=300)
    return pdf if pdf.exists() else None


def contact_sheet(pngs: list[Path], out: Path, cols: int = 4, tile_w: int = 480, label: str = "") -> Path | None:
    if not pngs:
        return None
    ims = [Image.open(p).convert("RGB") for p in pngs]
    th = int(tile_w * ims[0].height / ims[0].width)
    rows = -(-len(ims) // cols)
    gap, top = 16, 56 if label else 16
    sheet = Image.new("RGB", (cols * tile_w + (cols + 1) * gap, rows * (th + gap + 22) + top), (24, 24, 26))
    d = ImageDraw.Draw(sheet)
    try:
        f = ImageFont.truetype(str(STUDIO / "assets/fonts/Inter-Medium.otf"), 15)
        fl = ImageFont.truetype(str(STUDIO / "assets/fonts/Inter-SemiBold.otf"), 22)
    except Exception:
        f = fl = ImageFont.load_default()
    if label:
        d.text((gap, 16), label, fill=(240, 240, 240), font=fl)
    for i, im in enumerate(ims):
        x = gap + (i % cols) * (tile_w + gap)
        y = top + (i // cols) * (th + gap + 22)
        sheet.paste(im.resize((tile_w, th), Image.LANCZOS), (x, y + 22))
        d.text((x, y + 2), f"{i + 1:02d}", fill=(170, 170, 176), font=f)
    out.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(out)
    return out
