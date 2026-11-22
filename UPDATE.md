# Update from the PC: Visit 1 done, Sprint 2 done

Read this on the Mac before picking the project back up. Details and reasons are in
[docs/DECISIONS.md](docs/DECISIONS.md); the schedule is in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Catch up on the Mac

```sh
git pull
pnpm install                 # the daemon gained one dependency (yaml)
pnpm typecheck && pnpm test  # model-free; heavy tests still run only in CI or with LS_HEAVY_TESTS=1
(cd worker && .venv/bin/python -m pytest -q)
```

No worker reinstall is needed (editable install). Field kit reports are now gitignored and stay on
the PC, so `reports/` on the Mac only has its README.

## What Visit 1 decided

- **Facets:** model-free rules plus the query vector. Laya is out of the daemon (less accurate,
  far too slow, its GPU path failed); it stays in the field kit for re-tests.
- **OCR:** Windows OCR first, RapidOCR as fallback (already the worker's order).
- **Images without text:** indexed by metadata stored in the file (format, size, EXIF date and
  camera, description, Windows title/keywords, PNG text). No captioning model.
- **Code files:** not indexed in v1. Program, game and code-project folders are skipped entirely.
- **Embedder:** embeddinggemma stays (the bigger model wasn't worth being several times slower).
- **Reranking and query expansion:** built, but off by default (config switches).
- **Everything integration:** dropped.

## What Sprint 2 built

| Area | Where | What |
|---|---|---|
| Query terms | `packages/daemon/src/shared/text.ts` | Stemmed, filler-word-free terms weighted by rarity in the index; file names split into parts. |
| Planner | `packages/daemon/src/planner/index.ts` | Time windows (dates, seasons, bare years, "or a little earlier"), recency, type, screenshot, origin. |
| Ranking | `packages/daemon/src/search/index.ts` | `rankGroups()` fuses lists, then plan boosts (nothing filtered); optional expansion and rerank on top. Ties in name matches share a rank. |
| Re-extraction | `packages/daemon/src/ingest/index.ts` | Text from an older extractor version is re-extracted automatically. |
| Config | `~/.local-search/config.yaml` | `roots`, extra `excludeDirs`, `rerank`, `expand`, `port`. Optional; defaults work. |
| Daemon | `packages/daemon/src/serve.ts` | `lsd serve`: resident embedder, localhost API, background indexing (low priority, pauses while the GPU is busy, watches for file changes, hourly rescan). |

The bench on the PC improved a lot over the Visit 1 baseline and now beats the qmd baseline, at a
few tens of milliseconds per search. The test set is small and the fixes were diagnosed on it, so
treat that as optimistic.

## For Sprint 3 (the popup) on the Mac

The popup talks to `lsd serve`. On the Mac, run it without models and point it at the synthetic
fixtures only (otherwise it indexes the Mac's own user folders):

```sh
mkdir -p ~/.local-search
printf 'roots:\n  - %s/fixtures/corpus\n' "$PWD" > ~/.local-search/config.yaml
pnpm lsd serve --embedder hash
```

`lsd serve` scans and indexes on start (the fixtures take seconds), then answers on the API below.

API (127.0.0.1, port 7337 by default; token in `~/.local-search/token`, sent as
`Authorization: Bearer <token>`):

- `GET /search?q=<text>&n=<1-50>` → `{ q, ms, hits: [{ paths, score, snippet, page, trace }] }`
  (`paths[0]` is the file to open; `trace` explains the score, including plan boosts)
- `GET /status` → `{ files: { indexed, queued, skipped, failed, … }, indexer: "idle" | "scanning" | "indexing" | "paused" | "off" }`
- `POST /reindex` → `202`

Searches sent through the API are logged with their plan in the `queries` table, ready for the
feedback work in Sprint 3.

## Open items

- One image-only search in the private test set still misses; look at OCR text and spelling
  variants on the next visit.
- The GPU-busy pause is unit-tested with a fake probe but hasn't been watched during a game.
- The private test set is small; adding searches would make the next tuning round trustworthy.
- The field kit's own default roots and the daemon's config are separate files (`fieldkit.yaml`
  in the repo root, gitignored; `~/.local-search/config.yaml`).
