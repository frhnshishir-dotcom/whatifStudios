"""Builds the project's still assets: graded Lagos photo (CC BY-SA 2.0 adaptation) and the Nigeria dot map.
Run: python projects/revolut-nigeria/scripts/make_assets.py"""
import json
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

P = Path(__file__).resolve().parents[1]
IMG = P / "assets" / "images"
FONTS = P.parents[1] / "assets" / "fonts"


def grade_lagos():
    """Blue-hour grade: the flat overcast sky is replaced by a navy-to-dusk gradient through a soft
    brightness mask; the city gets cool shadows and a gentle lift on its practical lights."""
    im = Image.open(IMG / "lagos_skyline_original.jpg").convert("RGB")
    # Remove third-party trademarks (a bank's logo and name on the tower, billboards): a competitor's brand on a
    # Revolut case-study slide could imply a partnership that does not exist.
    im.paste(im.crop((848, 440, 1032, 482)).resize((184, 42)), (848, 482))     # roof name sign -> sky from just above
    im.paste(im.crop((818, 800, 950, 940)), (818, 652))                          # logo panel -> plain facade from below
    for box in [(962, 778, 1110, 1125), (1418, 902, 1532, 988), (556, 996, 668, 1044)]:   # billboards: soft, unreadable
        im.paste(im.crop(box).filter(ImageFilter.GaussianBlur(16)), box[:2])
    a = np.asarray(im, np.float32) / 255
    h, w, _ = a.shape
    yy = np.linspace(0, 1, h)[:, None]
    lum = a.mean(2)
    sat = a.max(2) - a.min(2)
    m = np.clip((lum - 0.58) / 0.12, 0, 1) * np.clip((0.12 - sat) / 0.08, 0, 1) * np.clip((0.78 - yy) / 0.2, 0, 1)
    m = np.asarray(Image.fromarray((m * 255).astype(np.uint8)).filter(ImageFilter.MaxFilter(7)).filter(ImageFilter.GaussianBlur(3)), np.float32)[..., None] / 255
    top, mid, low = np.array([0.03, 0.05, 0.12]), np.array([0.13, 0.21, 0.42]), np.array([0.55, 0.45, 0.47])
    t = np.clip(yy / 0.72, 0, 1)[..., None]
    sky = np.where(t < 0.6, top + (mid - top) * (t / 0.6), mid + (low - mid) * ((t - 0.6) / 0.4))
    sky = np.broadcast_to(sky, a.shape)
    city = a * np.array([0.76, 0.83, 1.0]) * 0.72                      # cool, a stop down
    city = city + np.clip(lum - 0.8, 0, 1)[..., None] * np.array([0.6, 0.45, 0.2])   # warm practical lights
    out = sky * m + city * (1 - m)
    out = np.clip((out - 0.015) * 1.1, 0, 1)
    Image.fromarray((out * 255).astype(np.uint8)).save(IMG / "lagos_skyline_graded.jpg", quality=92)
    print("graded", im.size)


def nigeria_map():
    g = json.load(open(P / "research" / "nigeria_outline.geojson"))["geometry"]
    polys = g["coordinates"] if g["type"] == "MultiPolygon" else [g["coordinates"]]
    lon0, lon1, lat0, lat1 = 2.5, 14.9, 4.0, 14.0
    W, H = 1500, 1300
    S = 2
    def xy(lon, lat):
        return ((lon - lon0) / (lon1 - lon0) * W * S, (1 - (lat - lat0) / (lat1 - lat0)) * H * S)
    mask = Image.new("L", (W * S, H * S), 0)
    d = ImageDraw.Draw(mask)
    for poly in polys:
        d.polygon([xy(*c) for c in poly[0]], fill=255)
    m = np.asarray(mask) > 0
    out = Image.new("RGBA", (W * S, H * S), (0, 0, 0, 0))
    od = ImageDraw.Draw(out)
    step, r = 22 * S, 5.0 * S
    for y in range(0, H * S, step):
        for x in range(0, W * S, step):
            if m[y, x]:
                od.ellipse((x - r, y - r, x + r, y + r), fill=(170, 184, 207, 235))
    # outline
    for poly in polys:
        od.line([xy(*c) for c in poly[0]] + [xy(*poly[0][0])], fill=(152, 165, 186, 90), width=2 * S)
    f = ImageFont.truetype(str(FONTS / "IBMPlexMono-Medium.ttf"), 26 * S)
    for name, lon, lat, col, big in [("LAGOS", 3.3792, 6.5244, (0, 168, 107), True), ("ABUJA", 7.3986, 9.0765, (143, 176, 255), False), ("KANO", 8.5167, 12.0, (143, 176, 255), False)]:
        x, y = xy(lon, lat)
        for rr, al in ([(70, 40), (46, 80), (26, 255)] if big else [(30, 60), (14, 255)]):
            rr *= S / 2
            od.ellipse((x - rr, y - rr, x + rr, y + rr), fill=col + (al,))
        od.text((x + 40 * S, y - 16 * S), name, font=f, fill=col + (255,))
    out = out.resize((W, H), Image.LANCZOS)
    out.save(IMG / "nigeria_dot_map.png")
    print("map", out.size)


if __name__ == "__main__":
    import sys
    if "map" not in sys.argv[1:]:
        grade_lagos()
    nigeria_map()
