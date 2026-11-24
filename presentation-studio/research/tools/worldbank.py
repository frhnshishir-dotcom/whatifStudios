#!/usr/bin/env python3
"""Fetch World Bank WDI indicators (free, no key) and record provenance.

  python research/tools/worldbank.py IT.NET.USER.ZS WLD,SSF,NAC --from 2005 --to 2024 --project connected-planet

Writes projects/<project>/research/wb_<indicator>.json (raw API rows + fetch time) and prints a source entry
to paste into deck.json "sources". Values come straight from the API: never retype numbers by hand.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import sys
import urllib.request
from pathlib import Path

API = "https://api.worldbank.org/v2"
STUDIO = Path(__file__).resolve().parents[2]


def get(url: str):
    req = urllib.request.Request(url, headers={"User-Agent": "PresentationStudio/1.0"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read())


def fetch(indicator: str, countries: list[str], y0: int, y1: int) -> dict:
    out = {"indicator": indicator, "fetched": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"), "series": {}}
    meta = get(f"{API}/indicator/{indicator}?format=json")[1][0]
    out["name"] = meta["name"]
    out["source_note"] = meta.get("sourceNote", "")
    out["source_org"] = meta.get("sourceOrganization", "")
    for c in countries:
        page = get(f"{API}/country/{c}/indicator/{indicator}?format=json&date={y0}:{y1}&per_page=200")
        rows = page[1] or []
        out["lastupdated"] = page[0].get("lastupdated")
        name = rows[0]["country"]["value"] if rows else c
        out["series"][c] = {"name": name, "values": {r["date"]: r["value"] for r in sorted(rows, key=lambda r: r["date"])}}
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("indicator")
    ap.add_argument("countries", help="comma-separated ISO3 / aggregate codes, e.g. WLD,SSF,NAC")
    ap.add_argument("--from", dest="y0", type=int, default=2000)
    ap.add_argument("--to", dest="y1", type=int, default=2024)
    ap.add_argument("--project")
    a = ap.parse_args()
    d = fetch(a.indicator, a.countries.split(","), a.y0, a.y1)
    if a.project:
        p = STUDIO / "projects" / a.project / "research" / f"wb_{a.indicator.replace('.', '_')}.json"
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps(d, indent=1))
        print(f"saved {p.relative_to(STUDIO)}", file=sys.stderr)
    src = {
        "id": "wb_" + a.indicator.lower().replace(".", "_"), "type": "dataset", "author": "World Bank",
        "year": int(d["lastupdated"][:4]) if d.get("lastupdated") else None,
        "title": d["name"], "publisher": "World Development Indicators",
        "url": f"https://data.worldbank.org/indicator/{a.indicator}", "accessed": d["fetched"][:10],
        "license": "CC BY 4.0", "verified": True, "note": d["source_org"],
    }
    print(json.dumps(src, indent=1))


if __name__ == "__main__":
    main()
