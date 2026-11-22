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

Decisions so far are in [DECISIONS.md](DECISIONS.md); reranking and expansion settings are still
open until the Visit 1 bench.

Query embedding, a BM25 probe and facets run first. Facets (time, origin, type, topic) come from
model-free rules plus the query vector; Laya is not used. Retrievers (filename and folder name,
keyword, vector, facet scores) are fused with RRF, the original query at 2x weight. The top
results are reranked as short snippets (how many is still open), followed by a position-aware
blend and a confidence threshold. Every model costs about 2 × parameters × tokens, so LLM query
expansion stays off the per-query path and may run only when the first results are weak.

## Schedule

Development follows the visits, because only the PC can answer the open questions.

| When | Work |
|---|---|
| Before Visit 1 (done) | Schema, worker, field kit (S1–S7, S4b), `lsd index / search / bench`, CI dry run |
| Visit 1 | Field kit, private test set, one-folder index + bench. Decide: embedder, OCR engine, facet routing, expansion, rerank size |
| Sprint 2 | Planner and facets as decided (rules + query vector); Everything integration; background index queue; models resident; daemon API |
| Visit 2 | Full index; bench vs qmd; tune |
| Sprint 3 | Tauri popup (built on the Mac against a model-free dev index); feedback; category tree and receipt fields (generated on the PC) |
| Visits 3–4 | Daily use and tuning |

## Development model

Code on the Mac (no models are run there). CI runs tests on macOS and Windows on every push. Each visit to the PC
runs `pnpm fieldkit run` (see `docs/FIELD-VISIT.md`). Reports stay on the PC; only the decisions
written up from them are committed.
