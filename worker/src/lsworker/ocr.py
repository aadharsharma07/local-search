"""OCR engines behind one interface: image in, text out.

Engines:
- windows:   Windows.Media.Ocr via pywinrt (Windows only, built into the OS)
- rapidocr:  PaddleOCR models on ONNX Runtime (cross-platform, pip-installable)
- tesseract: pytesseract + the tesseract binary

Spike S5 decides which engine is the default on the PC.
"""

from __future__ import annotations

import shutil
import sys
from functools import lru_cache
from typing import Callable

from PIL import Image

OcrFn = Callable[[Image.Image], str]


def _windows() -> OcrFn | None:
    if sys.platform != "win32":
        return None
    try:
        import asyncio

        from winrt.windows.graphics.imaging import BitmapPixelFormat, SoftwareBitmap
        from winrt.windows.media.ocr import OcrEngine
        from winrt.windows.storage.streams import DataWriter
    except Exception:
        return None

    engine = OcrEngine.try_create_from_user_profile_languages()
    if engine is None:
        return None
    max_dim = int(OcrEngine.max_image_dimension)

    def run(img: Image.Image) -> str:
        img = img.convert("RGBA")
        if max(img.size) > max_dim:
            img.thumbnail((max_dim, max_dim))
        r, g, b, a = img.split()
        bgra = Image.merge("RGBA", (b, g, r, a)).tobytes()
        writer = DataWriter()
        writer.write_bytes(bgra)
        bitmap = SoftwareBitmap.create_copy_from_buffer(
            writer.detach_buffer(), BitmapPixelFormat.BGRA8, img.width, img.height
        )

        async def recognize() -> str:
            result = await engine.recognize_async(bitmap)
            return "\n".join(line.text for line in result.lines)

        return asyncio.run(recognize())

    return run


def _rapidocr() -> OcrFn | None:
    try:
        import numpy as np
        from rapidocr import RapidOCR
    except Exception:
        return None
    engine = RapidOCR()

    def run(img: Image.Image) -> str:
        result = engine(np.asarray(img.convert("RGB")))
        txts = getattr(result, "txts", None) or ()
        return "\n".join(txts)

    return run


def _tesseract() -> OcrFn | None:
    if shutil.which("tesseract") is None:
        return None
    try:
        import pytesseract
    except Exception:
        return None
    return lambda img: pytesseract.image_to_string(img)


_FACTORIES: dict[str, Callable[[], OcrFn | None]] = {
    "windows": _windows,
    "rapidocr": _rapidocr,
    "tesseract": _tesseract,
}
PREFERENCE = ["windows", "rapidocr", "tesseract"]


@lru_cache(maxsize=None)
def get_engine(name: str) -> OcrFn | None:
    factory = _FACTORIES.get(name)
    return factory() if factory else None


def available_engines() -> list[str]:
    return [name for name in PREFERENCE if get_engine(name) is not None]


def resolve(name: str) -> tuple[str, OcrFn] | None:
    """Resolve "auto" or a named engine to (name, fn); None if nothing is available."""
    names = PREFERENCE if name == "auto" else [name]
    for n in names:
        fn = get_engine(n)
        if fn is not None:
            return n, fn
    return None
