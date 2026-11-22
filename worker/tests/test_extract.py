import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

from lsworker import ocr
from lsworker.extract import extract, kind_for

CORPUS = Path(__file__).resolve().parents[2] / "fixtures" / "corpus"
# OCR loads a model, so OCR tests only run in CI (or with LS_HEAVY_TESTS=1), never on the dev Mac.
HEAVY = bool(os.environ.get("CI") or os.environ.get("LS_HEAVY_TESTS"))
HAS_OCR = HEAVY and bool(ocr.available_engines())


def test_kinds():
    assert kind_for(".PDF") == "document"
    assert kind_for(".png") == "image"
    assert kind_for(".ps1") == "code"
    assert kind_for(".md") == "text"
    assert kind_for(".exe") == "other"


def test_text_pdf_keeps_pages():
    r = extract(CORPUS / "Documents/Housing/lease.pdf")
    assert r.ok, r.error
    assert [p.page for p in r.pages] == [1, 2]
    assert "$1,650 per month" in r.pages[1].text
    assert all(p.method == "text" for p in r.pages)


def test_docx_includes_tables():
    r = extract(CORPUS / "Documents/Taxes/2023 return summary.docx")
    assert r.ok, r.error
    assert "Refund | $1,240.00" in r.text


def test_cp1252_and_unicode_names():
    assert "naïve" in extract(CORPUS / "Documents/Notes/journal-2019.txt").text
    r = extract(CORPUS / "Documents/Notes/café menu ideas.md")
    assert r.ok and "Crème brûlée" in r.text


def test_corrupt_pdf_fails_cleanly():
    r = extract(CORPUS / "Downloads/broken-statement.pdf")
    assert not r.ok
    assert r.error


def test_unsupported_and_missing(tmp_path):
    exe = tmp_path / "setup.exe"
    exe.write_bytes(b"MZ")
    assert "unsupported" in (extract(exe).error or "")
    r = extract(CORPUS / "does-not-exist.pdf")
    assert not r.ok and "FileNotFoundError" in (r.error or "")


def test_size_limit(tmp_path):
    big = tmp_path / "big.txt"
    big.write_bytes(b"a" * 2048)
    r = extract(big, max_bytes=1024)
    assert not r.ok and "too large" in (r.error or "")


@pytest.mark.skipif(not HAS_OCR, reason="OCR tests run in CI only (or LS_HEAVY_TESTS=1)")
def test_scanned_pdf_uses_ocr():
    r = extract(CORPUS / "Documents/Bills/scan-2024-01-0007.pdf")
    assert r.ok, r.error
    assert r.pages[0].method.startswith("ocr:")
    assert "84.12" in r.text


@pytest.mark.skipif(not HAS_OCR, reason="OCR tests run in CI only (or LS_HEAVY_TESTS=1)")
def test_screenshot_ocr():
    r = extract(CORPUS / "Pictures/Screenshots/Screenshot 2025-05-11 213344.png")
    assert r.ok, r.error
    assert "QX7P2L" in r.text.replace(" ", "")


def _meta(r):
    pages = [p for p in r.pages if p.method == "meta"]
    assert len(pages) == 1, r.pages
    return pages[0].text


def test_image_metadata_exif(tmp_path):
    from PIL import Image

    img = Image.new("RGB", (300, 400), "white")
    exif = Image.Exif()
    exif[0x010F] = "Pixel"  # Make
    exif[0x0110] = "7a"  # Model
    exif[0x010E] = "concert poster"  # ImageDescription
    exif[0x9C9E] = "poster;music".encode("utf-16-le")  # XPKeywords
    exif.get_ifd(0x8769)[0x9003] = "2025:06:14 10:20:30"  # DateTimeOriginal
    path = tmp_path / "IMG_0001.jpg"
    img.save(path, exif=exif)

    r = extract(path, "none")
    assert r.ok, r.error
    meta = _meta(r)
    for want in ("JPEG photo", "portrait", "taken 2025-06-14", "June 2025", "camera Pixel 7a",
                 "concert poster", "poster;music"):
        assert want in meta, meta
    assert r.content_date is not None
    assert "IMG_0001" not in meta  # nothing path-derived


def test_image_metadata_png_text(tmp_path):
    from PIL import Image, PngImagePlugin

    info = PngImagePlugin.PngInfo()
    info.add_text("Software", "Snipping Tool")
    info.add_text("Title", "flight confirmation")
    path = tmp_path / "shot.png"
    Image.new("RGB", (1920, 1080)).save(path, pnginfo=info)

    r = extract(path, "none")
    meta = _meta(r)
    assert "PNG image" in meta and "landscape" in meta
    assert "software: Snipping Tool" in meta and "title: flight confirmation" in meta
    assert r.content_date is None


def test_image_without_metadata_still_gets_meta_page(tmp_path):
    from PIL import Image

    path = tmp_path / "plain.png"
    Image.new("RGB", (50, 50)).save(path)
    r = extract(path, "none")
    assert r.ok, r.error
    assert _meta(r).startswith("PNG image. 50x50 pixels, square")
    assert r.to_json()["content_date"] is None


def test_server_protocol():
    reqs = [
        {"id": 1, "op": "ping"},
        {"id": 2, "op": "extract", "path": str(CORPUS / "Documents/Notes/banana bread.txt")},
        {"id": 3, "op": "nope"},
    ]
    out = subprocess.run(
        [sys.executable, "-m", "lsworker.server"],
        input="\n".join(json.dumps(r) for r in reqs) + "\n",
        capture_output=True, text=True, encoding="utf-8", timeout=60, check=True,
    ).stdout.splitlines()
    res = [json.loads(line) for line in out]
    assert [r["id"] for r in res] == [1, 2, 3]
    assert res[0]["ok"] and res[1]["ok"] and not res[2]["ok"]
    assert "ripe bananas" in res[1]["result"]["text"]


@pytest.mark.skipif(sys.platform != "win32", reason="Windows only")
def test_windows_ocr_engine():
    if "windows" not in ocr.available_engines():
        pytest.skip("Windows OCR unavailable (no OCR language pack on this machine)")
    r = extract(CORPUS / "Pictures/Screenshots/Screenshot 2025-05-11 213344.png", "windows")
    assert r.ok, r.error
    assert r.ocr_engine == "windows"
    assert "Vancouver" in r.text


@pytest.mark.skipif(sys.platform != "win32", reason="Windows only")
def test_cloud_attrs_on_normal_files():
    from lsworker.server import cloud_attrs

    res = cloud_attrs([str(CORPUS / "Documents/Housing/lease.pdf"), str(CORPUS / "missing.pdf")])
    assert res == {"supported": True, "placeholders": []}


def test_ocr_none_never_loads_a_model():
    img = extract(CORPUS / "Pictures/Screenshots/Screenshot 2025-05-11 213344.png", "none")
    assert img.ok and img.pages[0].text == "" and img.pages[0].method == "none"
    assert img.text == _meta(img)  # only the metadata page carries text
    scan = extract(CORPUS / "Documents/Bills/scan-2024-01-0007.pdf", "none")
    assert scan.ok and all(p.method == "text" for p in scan.pages)
