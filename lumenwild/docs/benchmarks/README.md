# Benchmarks

Two reproducible benchmarks. Their JSON reports go to `bench-results/` (not committed); summaries of the reference
runs are kept in this folder.

| Command | What it does |
|---|---|
| `npm run bench:server` | Builds the world server from source, runs seeded bots over real WebSockets in two scenarios, and times every server tick |
| `npm run bench:continent` | Builds the app, serves it, runs five fixed continent scenarios in Chromium, and reports fps, frame and CPU times, layers, heap and region moves |

**Server scenarios:**
- `together-16`: 16 bots around Lumenfall's square.
- `spread-18`: three bots in each of the six villages, so several areas are active at once.

**Server options:** `--secs N` (default 20), `--warm N` (default 3), `--scenario together-16|spread-18|all`.

**Continent scenarios:** `village`, `village-wide` (zoomed out), `night-storm`, `travel` (30 m/s for 25 s, crossing
region edges), `dragons` (all five on screen).

**Continent options:** `--headed`, `--presenter webgl2`, `--no-build`, `--port N`.

## On the target laptop (Windows, 8 GB, integrated graphics)

```
cd lumenwild
npm ci
npx playwright install chromium        # once
npm run bench:server
npm run bench:continent -- --headed    # headed uses the real GPU; headless may use software rendering
npm run bench:continent -- --headed --presenter webgl2
```

Keep the two JSON files from `bench-results/`; they become the reference numbers for the laptop.

## Reference runs

- [2026-11-27-baseline.md](2026-11-27-baseline.md): Phase 0 audit (scratch scripts).
- [2026-11-27-m0-before.md](2026-11-27-m0-before.md): these scripts, before M1 and M2 (cloud container).
