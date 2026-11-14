# local-search

A private, on-device replacement for Windows Search: ask in plain words, get the file back in under
a second. Nothing leaves the PC. Personal project; see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

**Status: Sprint 0.** Repo skeleton, index schema, extraction worker, synthetic fixtures and the
field kit. No search yet.

## Layout

| Path | What |
|---|---|
| `packages/daemon` | Node/TypeScript daemon. Today: the SQLite schema and migrations. |
| `packages/fieldkit` | Measurements run on the PC: census and spikes S1–S6. |
| `worker` | Python extraction worker (PDF, docx, text, code, OCR). |
| `fixtures` | Synthetic corpus, retrieval queries and Laya facet labels. All invented. |
| `reports` | Field kit reports from the PC. Aggregate numbers only. |
| `ui` | Search popup (Sprint 3). |

## Develop (Mac)

```sh
corepack enable
pnpm install
python3 -m venv worker/.venv
worker/.venv/bin/pip install -e "worker[ocr,dev]"

pnpm typecheck && pnpm test
(cd worker && .venv/bin/python -m pytest -q)

# Field kit against the fixtures (writes to fieldkit-out/, gitignored)
pnpm fieldkit run --fixtures --skip s6
```

Regenerate fixtures with `worker/.venv/bin/python fixtures/generate.py`.

## On the PC

Follow [docs/FIELD-VISIT.md](docs/FIELD-VISIT.md).
