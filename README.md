# local-search

A private, on-device replacement for Windows Search: ask in plain words, get the file back in under
a second. Nothing leaves the PC. Personal project; see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

**Status: Sprint 2 done.** Built: index schema, extraction worker, field kit, query planner and
hybrid search, and `lsd serve` (localhost API, background indexing). Commands:
`pnpm lsd index | search | bench | serve`. Decisions: [docs/DECISIONS.md](docs/DECISIONS.md);
schedule: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Next: Sprint 3 (search popup).

## Layout

| Path | What |
|---|---|
| `packages/daemon` | Node/TypeScript daemon: schema, ingest pipeline, hybrid search, `lsd` CLI. |
| `packages/fieldkit` | Measurements run on the PC: census and spikes S1–S6. |
| `worker` | Python extraction worker (PDF, docx, text, code, OCR). |
| `fixtures` | Synthetic corpus, retrieval queries and Laya facet labels. All invented. |
| `reports` | Field kit reports. Written on the PC and gitignored: they never leave it. |
| `ui` | Search popup (Sprint 3). |

## Develop (Mac)

The Mac is for writing code and quick tests. Do not run models or the field kit's spikes on it; OCR,
pipeline tests and the fixture smoke run happen in CI (macOS and Windows) on every push, and real measurements
happen on the PC.

```sh
corepack enable
pnpm install
python3 -m venv worker/.venv
worker/.venv/bin/pip install -e "worker[ocr,dev]"
```

Quick model-free tests are fine on the Mac (OCR and pipeline tests skip themselves outside CI):

```sh
pnpm typecheck && pnpm test
(cd worker && .venv/bin/python -m pytest -q)
```

Regenerate fixtures with `worker/.venv/bin/python fixtures/generate.py`.

## On the PC

Follow [docs/FIELD-VISIT.md](docs/FIELD-VISIT.md).
