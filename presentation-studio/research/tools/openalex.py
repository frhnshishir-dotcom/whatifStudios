#!/usr/bin/env python3
"""Search OpenAlex (free scholarly index, no key) and print ready-to-use source entries.
  python research/tools/openalex.py "digital divide sub-saharan africa" --n 8 [--from 2019]
"""
import argparse
import json
import urllib.parse
import urllib.request

ap = argparse.ArgumentParser()
ap.add_argument("query")
ap.add_argument("--n", type=int, default=8)
ap.add_argument("--from", dest="y0", type=int)
a = ap.parse_args()
f = "type:article" + (f",from_publication_date:{a.y0}-01-01" if a.y0 else "")
url = ("https://api.openalex.org/works?" + urllib.parse.urlencode(
    {"search": a.query, "per-page": a.n, "filter": f, "sort": "relevance_score:desc"}))
with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "PresentationStudio/1.0"}), timeout=30) as r:
    res = json.loads(r.read())["results"]
out = []
for w in res:
    authors = [x["author"]["display_name"] for x in w.get("authorships", [])][:6]
    out.append({"id": (authors[0].split()[-1].lower() if authors else "anon") + str(w.get("publication_year")),
                "type": "article", "author": authors, "year": w.get("publication_year"), "title": w.get("title"),
                "container": (w.get("primary_location") or {}).get("source", {}) and (w["primary_location"]["source"] or {}).get("display_name"),
                "doi": (w.get("doi") or "").replace("https://doi.org/", ""), "cited_by": w.get("cited_by_count"),
                "open_access": (w.get("open_access") or {}).get("oa_url"), "verified": False})
print(json.dumps(out, indent=1, ensure_ascii=False))
