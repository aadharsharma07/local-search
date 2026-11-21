# Architecture

The full blueprint, with diagrams, is published at
https://claude.ai/artifact/KQ2fc5BmZG7iT2JMT54Qcz (private to the owner). This file is the short
version that lives next to the code.

## Scope (v1)

- Personal tool on one Windows 11 PC (Ryzen 5700X, RX 6600M 8 GB, 32 GB RAM).
- Job: find the file. Ranked results in ≤300 ms for filename-like queries, ≤700 ms for semantic ones.
- Indexes PDF, docx, txt/md, code and images (OCR). Not email, audio, video, archives or cloud-only files.
- Quality bar: recall@5 ≥ 85% on the private test set, beating Windows Search and qmd.

## Processes

- **Node daemon** (`packages/daemon`): the only owner of `index.sqlite` and of all models.
  Serves a localhost API with a random token. Runs ingest and queries.
- **Python extraction worker** (`worker/`): JSON lines over stdio, one file per request. No database
  access. The daemon times out, kills and restarts it on poison files.
- **Search popup** (`ui/`, Sprint 3): Tauri window on a global hotkey.
- **Platform layer**: Windows adapter (Zone.Identifier, cloud placeholder attributes, Windows OCR,
  Everything) and a macOS adapter for development.

## Data

One SQLite file: FTS5 for keywords, sqlite-vec for vectors. Text, chunks and vectors are keyed by
content hash. An embedding fingerprint in `meta` flags vectors stale when the model, prompt format
or chunk settings change. Schema: `packages/daemon/src/db/migrations.ts`.

## Query path (provisional until Visit 1)

Query embedding, a BM25 probe and model-free facet rules run first. Retrievers (filename, keyword,
vector, facet scores) are fused with RRF, the original query at 2x weight. The top 10 are reranked
as short snippets, followed by a position-aware blend and a confidence threshold. Every model costs
about 2 × parameters × tokens, so Laya and LLM query expansion stay off the per-query path unless
S4 and S7 show they fit the budget. Expansion may run only when the first results are weak.

## Schedule

Development follows the visits, because only the PC can answer the open questions.

| When | Work |
|---|---|
| Before Visit 1 (done) | Schema, worker, field kit (S1–S7, S4b), `lsd index / search / bench`, CI dry run |
| Visit 1 | Field kit, private test set, one-folder index + bench. Decide: embedder, OCR engine, facet routing, expansion, rerank size |
| Sprint 2 | Planner and facets as decided; Everything integration; idle-only job queue; daemon API |
| Visit 2 | Full overnight index if the visit allows; bench vs qmd; tune |
| Sprint 3 | Tauri popup (built on the Mac against a model-free dev index); feedback; category tree and receipt fields (generated on the PC) |
| Visits 3–4 | Daily use and tuning |

## Development model

Code on the Mac (no models are run there). CI runs tests on macOS and Windows on every push. Each visit to the PC
runs `pnpm fieldkit run` (see `docs/FIELD-VISIT.md`) and commits an aggregate-only report.
