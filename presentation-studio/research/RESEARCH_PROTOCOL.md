# Research protocol

1. **Source hierarchy:**
   - official statistics: World Bank, UN, OECD, national statistics offices, ITU, WHO
   - peer-reviewed research: OpenAlex or Crossref, preferring meta-analyses and recent work
   - company primary documents: annual reports, 10-K filings, investor decks, press kits
   - reputable journalism
   - everything else, only for context

   Never use content farms or uncited blog statistics.
2. **Record everything.** Each source gets an entry in `projects/<p>/sources.json`: id, type, author, year, title, publisher, url or doi, accessed, licence (for images), and `verified`.
3. **Verify.** Open the source and find the exact figure, year and unit. Only then set `"verified": true`. Save raw data under `projects/<p>/research/`.
4. **Numbers.** Copy them from the saved data, never from memory. State the year and unit on the slide. Round consistently.
5. **Freshness.** Use the latest available year, and say so ("2024, latest available").
6. **Images.** Use licensed sources only: Wikimedia Commons, Openverse, Poly Haven (CC0), or brand press kits under their terms. Record the licence and author.
7. **Quotes.** Use them only with a primary source (a speech transcript or an interview) linked in `sources`.
8. **Conflicts.** If two sources disagree, use the primary one and mention the other in the notes.

## Tools
- `python research/tools/worldbank.py <indicator> <codes> --project <p>`: World Bank WDI, free, no key.
- `python research/tools/openalex.py "query" --n 10`: scholarly works with DOIs and citation counts, free, no key.
- Claude WebSearch and the web-fetch agent, for official pages.
- The `anthropic-skills:deep-research` skill, for broad multi-source questions.
- The Crossref API (`api.crossref.org`), for DOI metadata.
