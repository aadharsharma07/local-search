# Architecture

The full blueprint, with diagrams, is published at
https://claude.ai/artifact/KQ2fc5BmZG7iT2JMT54Qcz (private to the owner). This file is the short
version that lives next to the code.

## Scope (v1)

- Personal tool on one mid-range Windows 11 desktop with an 8 GB AMD GPU.
- Job: find the file. Ranked results in ≤300 ms for filename-like queries, ≤700 ms for semantic ones.
- Indexes PDF, docx, txt/md and images (OCR text, plus metadata stored in the image). Not code,
  email, audio, video, archives or cloud-only files, and not program, game or code-project folders.
- Quality bar: recall@5 ≥ 85% on the private test set, beating Windows Search and qmd.

## Processes

- **Node daemon** (`packages/daemon`): the only owner of `index.sqlite` and of all models, which
  it loads once at start and keeps loaded. Serves a localhost API with a random token. Runs ingest
  (a low-priority background queue that pauses while the GPU is busy) and queries.
- **Python extraction worker** (`worker/`): JSON lines over stdio, one file per request. No database
  access. The daemon times out, kills and restarts it on poison files.
- **Search popup** (`ui/`, Sprint 3): Tauri window on a global hotkey.
- **Platform layer**: Windows adapter (Zone.Identifier, cloud placeholder attributes, Windows OCR,
  Everything) and a macOS adapter for development.

## Data

One SQLite file: FTS5 for keywords, sqlite-vec for vectors. Text, chunks and vectors are keyed by
content hash. An embedding fingerprint in `meta` flags vectors stale when the model, prompt format
or chunk settings change. Schema: `packages/daemon/src/db/migrations.ts`.

## Query path

Decisions and their reasons are in [DECISIONS.md](DECISIONS.md).

1. **Plan** (`packages/daemon/src/planner`): match terms (stemmed, filler removed, weighted by
   rarity in the index), a time window, recency, file type, screenshot and origin. Model-free.
2. **Retrieve**: keyword (FTS5/BM25), vector (embeddinggemma, the only resident model) and
   file/folder name lists, fused with RRF.
3. **Adjust** by the plan: time fit from the content date or modified time, newest/oldest first
   among close matches, small type/screenshot/origin boosts. Nothing is filtered.
4. **Optional, off by default**: query expansion when the first results are weak (fused with the
   original at 2x weight) and reranking of the top five.

## Schedule

Development follows the visits, because only the PC can answer the open questions.

| When | Work |
|---|---|
| Before Visit 1 (done) | Schema, worker, field kit (S1–S7, S4b), `lsd index / search / bench`, CI dry run |
| Visit 1 | Field kit, private test set, one-folder index + bench. Decide: embedder, OCR engine, facet routing, expansion, rerank size |
| Sprint 2 (done) | Query planner (dates, recency, type, origin); rarity-weighted terms; re-extract on upgrades; `lsd serve` with background index queue, resident embedder and localhost API; rerank/expansion switches (off). Everything integration dropped |
| Visit 2 | Full index; bench vs qmd; tune |
| Sprint 3 | Tauri popup (built on the Mac against a model-free dev index); feedback; category tree and receipt fields (generated on the PC) |
| Visits 3–4 | Daily use and tuning |

## Development model

Code on the Mac (no models are run there). CI runs tests on macOS and Windows on every push. Each visit to the PC
runs `pnpm fieldkit run` (see `docs/FIELD-VISIT.md`). Reports stay on the PC; only the decisions
written up from them are committed.
