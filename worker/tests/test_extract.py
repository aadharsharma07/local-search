import json
import subprocess
import sys
from pathlib import Path

import pytest

from lsworker import ocr
from lsworker.extract import extract, kind_for

CORPUS = Path(__file__).resolve().parents[2] / "fixtures" / "corpus"
HAS_OCR = bool(ocr.available_engines())


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


@pytest.mark.skipif(not HAS_OCR, reason="no OCR engine installed")
def test_scanned_pdf_uses_ocr():
    r = extract(CORPUS / "Documents/Bills/scan-2024-01-0007.pdf")
    assert r.ok, r.error
    assert r.pages[0].method.startswith("ocr:")
    assert "84.12" in r.text


@pytest.mark.skipif(not HAS_OCR, reason="no OCR engine installed")
def test_screenshot_ocr():
    r = extract(CORPUS / "Pictures/Screenshots/Screenshot 2025-05-11 213344.png")
    assert r.ok, r.error
    assert "QX7P2L" in r.text.replace(" ", "")


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
