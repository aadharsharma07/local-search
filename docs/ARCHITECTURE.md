# Architecture

The full blueprint, with diagrams, is published at
https://claude.ai/artifact/KQ2fc5BmZG7iT2JMT54Qcz (private to the owner). This file is the short
version that lives next to the code.

## Scope (v1)

- Personal tool on one Windows 11 PC (Ryzen 5700X, RX 6600 XT 8 GB, 32 GB RAM).
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

## Query path

Date parser and a BM25 probe run first. A decisive BM25 hit skips the language models. Otherwise
typed lex/vec/hyde expansion and Laya facet decisions run in parallel, then four retrievers
(filename, keyword, vector, facet scores), RRF fusion with the original query at 2x weight, rerank
of the top 10 as short snippets (rerank cost grows with tokens, so 40 full chunks is too slow on
this GPU), a position-aware blend, and a confidence threshold.

## Development model

Code on the Mac (no models are run there). CI runs tests on macOS and Windows on every push. Each visit to the PC
runs `pnpm fieldkit run` (see `docs/FIELD-VISIT.md`) and commits an aggregate-only report.
