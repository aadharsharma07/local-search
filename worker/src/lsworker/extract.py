"""Per-type text extraction. One file in, text (with page numbers when known) out.

Never raises for a bad file: errors are returned in the result so the caller can mark the
file failed and move on. Crashes and hangs are handled by the caller (timeout + restart).
"""

from __future__ import annotations

import time
from dataclasses import asdict, dataclass, field
from datetime import datetime
from pathlib import Path

from . import ocr

EXTRACTOR_VERSION = "0.2.0"  # 0.2.0: image metadata page + content_date
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
    content_date: int | None = None  # unix ms of a date stored inside the file (EXIF), if any

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


FORMAT_WORDS = {
    "JPEG": "JPEG photo image",
    "PNG": "PNG image",
    "WEBP": "WebP image",
    "GIF": "GIF image",
    "BMP": "bitmap image",
    "TIFF": "TIFF image scan",
}
# EXIF tags (base IFD and Exif sub-IFD) worth indexing as text.
_EXIF_TEXT = {0x010E: "description", 0x013B: "artist", 0x9286: "comment"}
_EXIF_XP = {0x9C9B: "title", 0x9C9F: "subject", 0x9C9E: "keywords", 0x9C9C: "comment"}
_PNG_TEXT_KEYS = ("title", "description", "comment", "software", "author", "subject", "keywords")


def _exif_date(raw: str | None) -> datetime | None:
    if not raw:
        return None
    try:
        return datetime.strptime(raw.strip()[:19], "%Y:%m:%d %H:%M:%S")
    except ValueError:
        return None


def _image_meta(img, res: Result) -> str:
    """Searchable text from metadata stored inside the image itself.

    Only content-intrinsic data: texts are keyed by content hash, so nothing derived from the
    path (file or folder names) may go in here. No GPS/location.
    """
    parts: list[str] = [FORMAT_WORDS.get(img.format or "", f"{img.format or ''} image".strip())]
    w, h = img.size
    parts.append(f"{w}x{h} pixels, {'portrait' if h > w else 'landscape' if w > h else 'square'}")

    exif = img.getexif()
    sub = exif.get_ifd(0x8769) if exif else {}
    taken = _exif_date(sub.get(0x9003) or exif.get(0x0132))  # DateTimeOriginal, else DateTime
    if taken:
        parts.append(f"taken {taken:%Y-%m-%d}, {taken:%B %Y}")
        res.content_date = int(taken.timestamp() * 1000)
    camera = " ".join(str(exif.get(t, "")).strip() for t in (0x010F, 0x0110)).strip()  # Make, Model
    if camera:
        parts.append(f"camera {camera}")
    for tag, label in _EXIF_TEXT.items():
        v = exif.get(tag) or sub.get(tag)
        if isinstance(v, bytes):  # UserComment carries an 8-byte charset header
            v = v[8:].decode("utf-8", errors="ignore") if v[:8] in (b"ASCII\0\0\0", b"UNICODE\0") else ""
        if isinstance(v, str) and v.strip(" \x00"):
            parts.append(f"{label}: {v.strip(chr(0)).strip()}")
    for tag, label in _EXIF_XP.items():
        v = exif.get(tag)
        if isinstance(v, (bytes, tuple)):  # Windows XP* tags: UTF-16LE bytes
            v = bytes(v).decode("utf-16-le", errors="ignore").strip("\x00 ")
            if v:
                parts.append(f"{label}: {v}")

    info = {k.lower(): v for k, v in (getattr(img, "text", None) or {}).items() if isinstance(v, str)}
    for key in _PNG_TEXT_KEYS:
        v = info.get(key, "").strip()
        if v:
            parts.append(f"{key}: {v[:300]}")
    return ". ".join(parts)


def _image(path: Path, res: Result, ocr_name: str) -> None:
    from PIL import Image

    if ocr_name == "none":
        # OCR switched off: the image is still indexed, by name and metadata only.
        with Image.open(path) as img:
            img.verify()
        res.pages.append(Page(None, "", "none"))
    else:
        engine = ocr.resolve(ocr_name)
        if engine is None:
            raise RuntimeError("no OCR engine available")
        name, fn = engine
        with Image.open(path) as img:
            img.load()
            res.pages.append(Page(None, fn(img).strip(), f"ocr:{name}"))
        res.ocr_engine = name
    # Always add metadata, so images with no readable text are still findable by more than name.
    with Image.open(path) as img:
        res.pages.append(Page(None, _image_meta(img, res), "meta"))


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
