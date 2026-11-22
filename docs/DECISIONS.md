# Decisions

What the field visits settled, and why. Reasons are kept qualitative on purpose: reports stay on
the PC (see `docs/FIELD-VISIT.md`), so nothing here describes the machine or its files.

## Visit 1

### 1. Facets come from rules plus the query vector; Laya is dropped from the daemon
Laya was less accurate than rules plus the query vector on every facet, far slower than the
per-query budget on the CPU, and its GPU (DirectML) path failed. It got only a handful of topic
labels right that the rules missed, and when the two disagree there is no way to tell which is
right, so it isn't worth keeping even as a fallback for weak results. Rules plus the query vector
add almost nothing on top of the query embedding the search already computes.

- Sprint 2: build the planner on the S4b approach (`packages/daemon/src/planner/rules.ts` plus the
  vector part of `packages/fieldkit/src/spikes/s4b.ts`). Laya stays in the field kit for re-tests.

### 2. OCR: Windows OCR first, RapidOCR as the fallback
Both engines gave the same quality on sampled files; Windows OCR was much faster on images. This
is already the worker's engine order (`worker/src/lsworker/ocr.py`), so nothing changes.

### 3. Images without readable text are indexed by their metadata
Most images have little or no readable text. Instead of adding a captioning or image-embedding
model, every image gets a metadata page built from what is stored inside the file: format, size
and orientation, EXIF date taken, camera, description, Windows title/subject/keywords/comment,
and PNG text fields (title, description, software). No location. The EXIF date is stored as the
content date for time facets. The file and folder names are matched by the filename retriever,
which now also looks at the parent folder name.

### 4. Code files are not indexed in v1
They are counted by the census but skipped by ingest. Program, game and code-project folders were
already skipped by the walker; loose code files are now skipped too.

### 5. Indexing runs in a simple background queue
A first full index finishes in minutes, not overnight, so the idle-only/overnight design isn't
needed. Sprint 2 builds a background queue that runs at low priority and pauses while the GPU is
busy (games, video).

### 6. Models load once at daemon start and stay loaded
Loading a model takes a long time, while the models use a small share of the GPU's memory. The
daemon (`lsd serve`) loads the embedder at start and keeps it loaded, so no search waits on a load;
the reranker and expander load at start too, but only when switched on (see 8).

### 7. Keep embeddinggemma
On its own, Qwen3-Embedding found more of the test set's files than embeddinggemma, but only as
many as plain keyword search, and it embeds several times slower. In the hybrid search the misses
were not caused by the embedder, so the fast model stays. Revisit if a larger test set shows
misses only the vector list could fix.

### 8. Reranking and query expansion exist but are off
Reranking cost about twice its budget and expansion far more; in the bench every found file was
already first, and no miss was a wording problem. Both are built behind config switches
(`rerank`, `expand` in `~/.local-search/config.yaml`), load their models only when switched on,
and can be benched later without new code. Expansion runs only when the first results are weak.

### 9. Everything integration is dropped
The index is small enough that our own filename matching answers instantly, and Everything is a
separate app to install and keep running.

## Sprint 2 (from the Visit 1 bench)

The bench misses were foundation problems, not model problems:
- **Filler words** ("the", "my", "made") diluted matching. Query words are now weighted by how
  rare they are in the index, file names are split into parts and plurals match. No LLM: it would
  cost about a second per query for a job a small program does.
- **Dates were ignored.** A query planner reads time windows (dates, seasons, bare years, "or a
  little earlier"), recency ("latest", "original"), file type, screenshots and download origin,
  and adjusts the fused ranking. Nothing is filtered out; `lsd search --explain` shows each boost.
- **Ties in name matches** were broken by path length; equal matches now share a rank.
- **Extractor upgrades** now re-extract old text.

Result on the private test set: every in-scope search found in the top five (from half), at a
few tens of milliseconds per query. The rules were diagnosed on that same small set, so the
number is optimistic until more searches are added.

Sprint 2 also added `lsd serve` (models resident, localhost API with a token, background indexing
at low priority that pauses while the GPU is busy) and the daemon config file.
