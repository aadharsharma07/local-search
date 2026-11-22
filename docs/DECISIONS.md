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
Loading the reranker takes a long time, while the embedder and reranker together use a small share
of the GPU's memory. The daemon loads both at start so no search ever waits on a load.

### Still open (waiting on S3, S6 and the bench)
- Embedding model: S3 compares embeddinggemma, Qwen3-Embedding and nomic.
- Reranking: reranking 10 snippets was over its budget (S2); the bench shows whether it is worth a
  smaller setting (fewer or shorter snippets, or only on weak results) or should be skipped.
- Query expansion: too slow for every query (S7); the bench shows how often results are weak.
- Baseline: qmd (S6) and our own bench on the private test set.
