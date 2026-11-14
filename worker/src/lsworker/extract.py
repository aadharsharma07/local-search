"""Per-type text extraction. One file in, text (with page numbers when known) out.

Never raises for a bad file: errors are returned in the result so the caller can mark the
file failed and move on. Crashes and hangs are handled by the caller (timeout + restart).
"""

from __future__ import annotations

import time
from dataclasses import asdict, dataclass, field
from pathlib import Path

from . import ocr

EXTRACTOR_VERSION = "0.1.0"
MIN_PAGE_CHARS = 20  # below this a PDF page is treated as scanned and OCR'd
OCR_DPI = 200

PDF_EXTS = {".pdf"}
IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff", ".gif"}
DOCX_EXTS = {".docx"}
CODE_EXTS = {
    ".py", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".go", ".rs", ".java", ".kt", ".c", ".h",
    ".cpp", ".hpp", ".cs", ".rb", ".php", ".swift", ".sh", ".ps1", ".bat", ".sql", ".lua", ".r",
    ".scala", ".css", ".scss", ".html", ".vue", ".svelte",
}
TEXT_EXTS = {".txt", ".md", ".markdown", ".csv", ".tsv", ".json", ".yaml", ".yml", ".toml",
             ".ini", ".log", ".xml", ".rst", ".tex", ".org"}


def kind_for(ext: str) -> str:
    ext = ext.lower()
    if ext in PDF_EXTS or ext in DOCX_EXTS:
        return "document"
    if ext in IMAGE_EXTS:
        return "image"
    if ext in CODE_EXTS:
        return "code"
    if ext in TEXT_EXTS:
        return "text"
    return "other"


@dataclass
class Page:
    page: int | None
    text: str
    method: str  # text | ocr:<engine> | docx | plain


@dataclass
class Result:
    path: str
    kind: str
    ok: bool
    extractor: str = EXTRACTOR_VERSION
    pages: list[Page] = field(default_factory=list)
    error: str | None = None
    ms: float = 0.0
    ocr_engine: str | None = None

    @property
    def text(self) -> str:
        return "\n\n".join(p.text for p in self.pages if p.text)

    def to_json(self) -> dict:
        d = asdict(self)
        d["text"] = self.text
        d["chars"] = len(d["text"])
        return d


def _decode(raw: bytes) -> str:
    if raw.startswith(b"\xef\xbb\xbf"):
        return raw[3:].decode("utf-8", errors="replace")
    if raw.startswith((b"\xff\xfe", b"\xfe\xff")):
        return raw.decode("utf-16", errors="replace")
    if b"\x00" in raw[:4096]:
        raise ValueError("binary content")
    try:
        return raw.decode("utf-8")
    except UnicodeDecodeError:
        return raw.decode("cp1252", errors="replace")


def _pdf(path: Path, res: Result, ocr_name: str) -> None:
    import pymupdf as fitz

    engine = None
    with fitz.open(path) as doc:
        if doc.needs_pass:
            raise ValueError("encrypted PDF")
        if doc.page_count == 0:
            raise ValueError("PDF has no readable pages")
        for i, page in enumerate(doc, start=1):
            text = page.get_text("text").strip()
            if len(text) >= MIN_PAGE_CHARS:
                res.pages.append(Page(i, text, "text"))
                continue
            if engine is None:
                engine = (ocr_name != "none" and ocr.resolve(ocr_name)) or False
            if not engine:
                res.pages.append(Page(i, text, "text"))
                continue
            name, fn = engine
            pix = page.get_pixmap(dpi=OCR_DPI)
            from PIL import Image

            img = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)
            res.pages.append(Page(i, fn(img).strip(), f"ocr:{name}"))
            res.ocr_engine = name


def _image(path: Path, res: Result, ocr_name: str) -> None:
    from PIL import Image

    if ocr_name == "none":
        # OCR switched off: the image is still indexed, by name and metadata only.
        with Image.open(path) as img:
            img.verify()
        res.pages.append(Page(None, "", "none"))
        return
    engine = ocr.resolve(ocr_name)
    if engine is None:
        raise RuntimeError("no OCR engine available")
    name, fn = engine
    with Image.open(path) as img:
        img.load()
        res.pages.append(Page(None, fn(img).strip(), f"ocr:{name}"))
    res.ocr_engine = name


def _docx(path: Path, res: Result) -> None:
    import docx

    d = docx.Document(str(path))
    parts = [p.text for p in d.paragraphs if p.text.strip()]
    for table in d.tables:
        for row in table.rows:
            cells = [c.text.strip() for c in row.cells]
            if any(cells):
                parts.append(" | ".join(cells))
    res.pages.append(Page(None, "\n".join(parts), "docx"))


def extract(path: str | Path, ocr_engine: str = "auto", max_bytes: int = 10 * 1024 * 1024) -> Result:
    p = Path(path)
    ext = p.suffix.lower()
    res = Result(path=str(p), kind=kind_for(ext), ok=False)
    t0 = time.perf_counter()
    try:
        size = p.stat().st_size
        if size > max_bytes:
            raise ValueError(f"file too large ({size} bytes)")
        if ext in PDF_EXTS:
            _pdf(p, res, ocr_engine)
        elif ext in IMAGE_EXTS:
            _image(p, res, ocr_engine)
        elif ext in DOCX_EXTS:
            _docx(p, res)
        elif ext in TEXT_EXTS or ext in CODE_EXTS:
            res.pages.append(Page(None, _decode(p.read_bytes()), "plain"))
        else:
            raise ValueError(f"unsupported type {ext or '(none)'}")
        res.ok = True
    except Exception as e:  # noqa: BLE001 - report every failure, never crash the worker
        res.error = f"{type(e).__name__}: {e}"
    res.ms = round((time.perf_counter() - t0) * 1000, 1)
    return res
