# Field visit checklist (home PC)

Each visit to the Windows PC is a short scripted session. You run one command that measures
everything that needs the real GPU and your real files, then commit the report. The report holds
aggregate numbers only. Your files, the private test set and the S5 review file never leave the PC.

Set aside about 45 minutes the first time (setup plus model downloads). Later visits take about 10.

## 1. One-time setup (Visit 1 only)

Install, if missing:

- **Git**: https://git-scm.com/download/win
- **Node.js 24 LTS**: https://nodejs.org (the installer adds `corepack`)
- **Python 3.12** from https://python.org. Tick "Add python.exe to PATH".
- **Everything** (voidtools), optional for now. The query engine uses it from Sprint 2.

Then, in PowerShell:

```powershell
corepack enable
cd $HOME\projects
git clone https://github.com/aadharsharma07/local-search.git
cd local-search
pnpm install
py -3.12 -m venv worker\.venv
worker\.venv\Scripts\python -m pip install --upgrade pip
worker\.venv\Scripts\python -m pip install -e "worker[ocr,windows]"
```

Check that Windows OCR has an English language pack: Settings → Time & language → Language & region.
English should be listed with "Optical character recognition" among its features. If it is not,
S5 still runs with the other OCR engines and reports that Windows OCR was missing.

## 2. Optional: pick folders

By default the field kit scans Documents, Downloads, Desktop and Pictures in your user folder.
To change that, copy `fieldkit.example.yaml` to `fieldkit.yaml` and edit `roots`. `fieldkit.yaml`
is gitignored.

## 3. Write the private test set (Visit 1, about 20 minutes)

```powershell
pnpm fieldkit testset init
notepad $HOME\.local-search\testset.json
pnpm fieldkit testset check
```

Write 20–30 searches you would really type, each with the file(s) that should come back. Mix them:

- a few where you remember part of the filename,
- several described only by meaning ("my lease", "the chair receipt"),
- a few with time ("last summer"), a few for screenshots or scanned documents,
- one or two for things that only exist as images.

Paths can be absolute or relative to `root`. `testset check` must say "Ready" before you continue.
The file stays in `%USERPROFILE%\.local-search\`, outside the repo.

## 4. Run the field kit

Close games and other GPU-heavy apps first.

```powershell
pnpm fieldkit run
```

Spikes that need the internet on first run download models into `%USERPROFILE%\.local-search\models`
(about 3 GB) and Laya into `%USERPROFILE%\.cache\receptron-laya` (1.7 GB). S6 runs qmd through `npx`
and downloads its own models (about 2 GB). Expect 20–60 minutes on the first visit, mostly downloads
and S3 embedding three models.

To rerun a single spike: `pnpm fieldkit s2`. To skip some: `pnpm fieldkit run --skip s6`.

## 5. Look, then commit the report

- Read `reports\<timestamp>\summary.md`.
- Skim the private review at `%USERPROFILE%\.local-search\private\s5-review-<date>.md` to see if
  the OCR text is what you expect. Do not commit it.

```powershell
git add reports
git commit -m "Field report: visit 1"
git push
```

Back on the Mac, `git pull` brings the numbers into the next sprint.

## What each spike decides

| Spike | Measures | Pass if | Decides |
|---|---|---|---|
| census | File counts, types, sizes, cloud-only files, download origins | info | Storage approach |
| s1 | Native libraries and the Python worker load | all load | Whether the stack works on Windows |
| s5 | Usable text from a sample of real files, per OCR engine; index size estimate | ≥90% usable | Default OCR engine |
| s2 | Embedding speed, first-index time, query embed and rerank latency on the GPU | first index ≤12 h, query embed ≤50 ms, rerank 10 snippets ≤400 ms | GPU settings, rerank size |
| s3 | recall@5 and MRR for three embedding models vs BM25 | info | Which embedding model |
| s4 | Laya facet accuracy (time via chrono + Laya) and latency on CPU and DirectML | ≥85%, p50 ≤250 ms | Laya vs a small LLM; CPU vs GPU |
| s6 | qmd on the same files and queries | info | The baseline to beat |

Why these targets: embedding and reranking cost about 2 × model parameters × tokens, so a
300M-parameter embedder on this GPU will do tens of chunks per second, not hundreds. The real
questions are whether the first full index finishes overnight (it runs in the background, idle
only) and whether each search stays fast. Reranking therefore uses 10 short snippets rather than
40 full chunks.
