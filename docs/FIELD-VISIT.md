# Field visit checklist (home PC)

Each visit to the Windows PC is a short scripted session. It measures everything that needs the
real GPU and your real files, then you commit the reports. Reports hold aggregate numbers only.
Your files, the private test set and the S5 review file never leave the PC.

Visit 1 takes about 2–3 hours, mostly model downloads and unattended runs. You need to be at
the keyboard for about 40 minutes of it.

## 0. Before you leave (on the Mac or phone)

Open GitHub → Actions → **fieldkit dry run** → **Run workflow**, and check that it's green. It runs
every step below on GitHub's Windows machine with the fixtures. A green run means the code will not
crash at home; it says nothing about speed.

## 1. One-time setup (Visit 1 only, about 15 minutes)

Install, if missing:

- **Git**: https://git-scm.com/download/win
- **Node.js 24 LTS**: https://nodejs.org (the installer adds `corepack`)
- **Python 3.12** from https://python.org. Tick "Add python.exe to PATH". (Or, if `uv` is
  installed: `uv python install 3.12`, then use `uv venv --python 3.12 worker\.venv` below.)
- **Visual Studio 2022 Build Tools** with the C++ workload *and* the ClangCL toolset.
  `better-sqlite3` 13 ships no Windows prebuilts, so `pnpm install` compiles it, and Node 24
  native builds use ClangCL. Without ClangCL the build fails with `MSB8020 ... ClangCL`.

  ```powershell
  winget install --id Microsoft.VisualStudio.2022.BuildTools -e --override "--wait --passive --norestart --add Microsoft.VisualStudio.Workload.VCTools --add Microsoft.VisualStudio.Component.VC.Llvm.Clang --add Microsoft.VisualStudio.Component.VC.Llvm.ClangToolset --includeRecommended"
  ```

Clone outside OneDrive (for example `$HOME\projects`, as below): OneDrive would otherwise sync
`node_modules`, the venv and every model download.

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

On later visits, replace all of this with `git pull` and `pnpm install`.

Check that Windows OCR has an English language pack: Settings → Time & language → Language & region.
English should list "Optical character recognition" among its features. If it doesn't, S5 still
runs with the other OCR engines and reports that Windows OCR was missing.

By default the field kit scans Documents, Downloads, Desktop and Pictures, wherever Windows has
put them (OneDrive folder backup moves them to `~\OneDrive\...`; this is read from the registry).
To change that, copy `fieldkit.example.yaml` to `fieldkit.yaml` (gitignored) and edit `roots`.
Use `excludeDirs` to skip folders that aren't personal files, such as work repositories on the
Desktop: they can dominate the census and the first-index estimate.

## 2. Write the private test set (Visit 1, about 20 minutes)

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

**Optional, but it makes S4/S4b fair:** give 10 or more queries a `facets` label, for example:

```json
{ "q": "the lease for my old apartment", "expected": ["Documents\\lease.pdf"],
  "facets": { "time": false, "origin": false, "type": "document", "content": "housing" } }
```

`type` is one of document, image, code, text, unspecified. `content` is one of finance, taxes,
housing, work, school, travel, code, art, recipes, health, personal.

## 3. Run the field kit (about 1–2 hours, unattended after the first minutes)

Close games and other GPU-heavy apps first.

```powershell
pnpm fieldkit run
```

First-run downloads go to `%USERPROFILE%\.local-search\models` (about 6 GB), plus Laya into
`%USERPROFILE%\.cache\receptron-laya` (1.7 GB). S6 runs qmd through `npx`, which downloads about
2 GB more. To rerun one spike: `pnpm fieldkit s2`. To skip one: `pnpm fieldkit run --skip s6`.

## 4. Index one folder and bench it (about 30–60 minutes)

Pick the folder that holds the most test-set answers (often Documents):

```powershell
pnpm lsd index --roots "$HOME\Documents"
pnpm lsd bench
```

`bench` only counts queries whose answer is inside the indexed folder and says how many that is.
Embeddings use embeddinggemma for now. If S3 picked a different model, note it; switching later
re-embeds automatically.

## 5. Look, then commit the reports

- Read `reports\<timestamp>\summary.md` and `reports\<timestamp>-bench\summary.md`.
- Skim the private review at `%USERPROFILE%\.local-search\private\s5-review-<date>.md` to check that
  the OCR text looks right. Do not commit it.

```powershell
git add reports
git commit -m "Field report: visit 1"
git push
```

## What each spike decides

| Spike | Measures | Pass if | Decides |
|---|---|---|---|
| census | File counts, types, sizes, cloud-only files, download origins | info | Storage approach |
| s1 | Native libraries and the Python worker load | all load | Whether the stack works on Windows |
| s5 | Usable text from a sample of real files, per OCR engine; index size estimate | ≥90% usable | Default OCR engine |
| s2 | Embedding speed, first-index time, query embed and rerank latency on the GPU | first index ≤12 h, query embed ≤50 ms, rerank 10 snippets ≤400 ms | GPU settings, rerank size |
| s3 | recall@5 and MRR for three embedding models vs BM25 | info | Which embedding model |
| s4 | Laya facet accuracy and latency on CPU and DirectML | ≥85%, p50 ≤250 ms | Whether Laya runs per query |
| s4b | Rules + query-vector facet accuracy (near-zero extra cost) | ≥85% | The cheap alternative to Laya |
| s7 | Text generation speed for the 1.7B expansion model and a 4B general model | info | Expansion per query or only on weak results |
| s6 | qmd on the same files and queries | info | The baseline to beat |
| bench | recall@5, MRR and latency of our own index on your queries | info | Our starting point vs qmd |

Why these targets: embedding, reranking and generation cost about 2 × model parameters × tokens,
so this GPU does tens of chunks per second, not hundreds. The questions that matter are whether
the first full index finishes overnight (it runs in the background, idle only) and whether each
search stays fast. So reranking uses 10 short snippets, and Laya and query expansion stay off the
per-query path unless the numbers say they're fast enough.
