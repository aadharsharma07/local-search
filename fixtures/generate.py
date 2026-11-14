"""Generate the synthetic fixture corpus. All people, companies and numbers are invented.

Run from the repo root with the worker venv:
    worker/.venv/bin/python fixtures/generate.py

Output goes to fixtures/corpus/ (committed). Re-running is deterministic.
"""

from __future__ import annotations

import datetime
import os
import random
import time
from pathlib import Path

import docx
import pymupdf as fitz
from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).parent / "corpus"
FIXED_DT = datetime.datetime(2024, 4, 22, 12, 0, 0)
random.seed(7)


def font(size: int) -> ImageFont.ImageFont:
    return ImageFont.load_default(size=size)


def text_pdf(path: Path, lines: list[str], meta_date: str) -> None:
    doc = fitz.open()
    page = doc.new_page()
    y = 72
    for line in lines:
        page.insert_text((72, y), line, fontsize=11)
        y += 18
    doc.set_metadata({"creationDate": meta_date, "modDate": meta_date, "producer": "fixtures"})
    path.parent.mkdir(parents=True, exist_ok=True)
    doc.save(path, garbage=4, deflate=True, no_new_id=True)


def text_image(lines: list[str], size=(1100, 700), scan=False) -> Image.Image:
    img = Image.new("RGB", size, (250, 250, 247) if scan else (255, 255, 255))
    d = ImageDraw.Draw(img)
    y = 40
    for i, line in enumerate(lines):
        d.text((50, y), line, fill=(25, 25, 25), font=font(34 if i == 0 else 26))
        y += 52 if i == 0 else 40
    if scan:
        img = img.rotate(0.8, expand=False, fillcolor=(250, 250, 247))
        noise = Image.effect_noise(size, 18).convert("RGB")
        img = Image.blend(img, noise, 0.08).filter(ImageFilter.GaussianBlur(0.6))
    return img


def scanned_pdf(path: Path, lines: list[str]) -> None:
    img = text_image(lines, size=(1275, 1650), scan=True)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".png")
    img.save(tmp)
    doc = fitz.open()
    page = doc.new_page(width=612, height=792)
    page.insert_image(page.rect, filename=str(tmp))
    path.parent.mkdir(parents=True, exist_ok=True)
    doc.save(path, garbage=4, deflate=True, no_new_id=True)
    tmp.unlink()


def write(path: Path, data: str | bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if isinstance(data, str):
        path.write_text(data, encoding="utf-8", newline="\n")
    else:
        path.write_bytes(data)


def _mk(path: Path) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    return path


def set_mtime(path: Path, iso: str) -> None:
    t = time.mktime(time.strptime(iso, "%Y-%m-%d"))
    os.utime(path, (t, t))


def main() -> None:
    files: dict[str, str] = {}  # relative path -> mtime date

    # 1. Text PDF receipt (the "office chair" query)
    p = ROOT / "Downloads/nordhem-order-88123.pdf"
    text_pdf(p, [
        "NORDHEM FURNITURE - Order Confirmation",
        "Order number: 88123        Order date: 2023-03-14",
        "Ship to: A. Customer, 41 Maple Row, Waterloo ON",
        "",
        "Item                                   Qty    Price",
        "Ergonomic office chair, mesh back, grey   1   $189.00",
        "Shipping                                       $0.00",
        "Total charged to Visa ****4417               $189.00",
        "",
        "Thank you for shopping at nordhem.example",
    ], "D:20230314120000")
    files["Downloads/nordhem-order-88123.pdf"] = "2023-03-14"

    # 2. Exact duplicate of the receipt under another name (content-hash dedupe)
    dup = ROOT / "Documents/Receipts/copy of nordhem-order-88123.pdf"
    dup.parent.mkdir(parents=True, exist_ok=True)
    dup.write_bytes(p.read_bytes())
    files["Documents/Receipts/copy of nordhem-order-88123.pdf"] = "2023-04-02"

    # 3. Scanned (image-only) utility bill
    scanned_pdf(ROOT / "Documents/Bills/scan-2024-01-0007.pdf", [
        "LAKEVIEW POWER & WATER",
        "Statement date: January 18, 2024",
        "Account: 5521-0098-31",
        "Electricity  612 kWh            $71.40",
        "Water        9.2 m3             $12.72",
        "Amount due by February 8, 2024:  $84.12",
    ])
    files["Documents/Bills/scan-2024-01-0007.pdf"] = "2024-01-20"

    # 4. Screenshot with text
    text_image([
        "Booking confirmed",
        "Flight NA 812  Toronto (YYZ) -> Vancouver (YVR)",
        "Wed 2 Jul 2025, departs 08:40, arrives 10:55",
        "Passenger: A. Customer   Seat 14C",
        "Confirmation code: QX7P2L",
    ]).save(_mk(ROOT / "Pictures/Screenshots/Screenshot 2025-05-11 213344.png"))
    files["Pictures/Screenshots/Screenshot 2025-05-11 213344.png"] = "2025-05-11"

    # 5. A drawing with no text at all (needs image captioning; expected miss until then)
    img = Image.new("RGB", (900, 600), "white")
    d = ImageDraw.Draw(img)
    d.ellipse((300, 220, 620, 420), outline="darkgreen", width=6)            # body
    d.polygon([(600, 260), (760, 160), (720, 300)], outline="darkgreen", width=6)  # head
    d.polygon([(380, 230), (440, 60), (520, 230)], outline="darkgreen", width=6)   # wing
    d.line([(320, 380), (140, 470), (120, 400)], fill="darkgreen", width=6)  # tail
    d.polygon([(760, 190), (860, 170), (860, 230)], fill="orange")           # fire
    (ROOT / "Pictures/Art").mkdir(parents=True, exist_ok=True)
    img.save(ROOT / "Pictures/Art/IMG_0412.png")
    files["Pictures/Art/IMG_0412.png"] = "2026-07-19"

    # 6. Tax summary (docx with a table)
    doc = docx.Document()
    doc.add_heading("2023 Personal Income Tax Summary", 1)
    doc.add_paragraph("Prepared for: A. Customer. Filed: April 22, 2024.")
    t = doc.add_table(rows=0, cols=2)
    for k, v in [("Employment income", "$58,300.00"), ("Tuition credits", "$6,120.00"),
                 ("Tax deducted at source", "$9,870.00"), ("Refund", "$1,240.00")]:
        row = t.add_row().cells
        row[0].text, row[1].text = k, v
    doc.core_properties.created = doc.core_properties.modified = FIXED_DT
    (ROOT / "Documents/Taxes").mkdir(parents=True, exist_ok=True)
    doc.save(ROOT / "Documents/Taxes/2023 return summary.docx")
    files["Documents/Taxes/2023 return summary.docx"] = "2024-04-22"

    # 7. Invoice (docx)
    doc = docx.Document()
    doc.add_heading("INVOICE #0042", 1)
    doc.add_paragraph("From: A. Customer, freelance web design")
    doc.add_paragraph("To: Brightline Bakery Co.")
    doc.add_paragraph("Date: May 6, 2024. Due: June 5, 2024.")
    doc.add_paragraph("Website redesign, 30 hours at $80/hour: $2,400.00")
    doc.save(_mk(ROOT / "Documents/Work/invoice-0042.docx"))
    files["Documents/Work/invoice-0042.docx"] = "2024-05-06"

    # 8. Lease (text PDF, two pages)
    p = ROOT / "Documents/Housing/lease.pdf"
    doc = fitz.open()
    pg = doc.new_page()
    pg.insert_text((72, 72), "RESIDENTIAL TENANCY AGREEMENT", fontsize=14)
    pg.insert_text((72, 100), "Landlord: Cedar Court Properties. Tenant: A. Customer.", fontsize=11)
    pg.insert_text((72, 118), "Premises: Unit 3B, 77 Fake Street, Waterloo ON", fontsize=11)
    pg.insert_text((72, 136), "Term: September 1, 2022 to August 31, 2023.", fontsize=11)
    pg2 = doc.new_page()
    pg2.insert_text((72, 72), "Rent: $1,650 per month, due on the first day of each month.", fontsize=11)
    pg2.insert_text((72, 90), "Security deposit: $1,650. Pets allowed with written consent.", fontsize=11)
    doc.save(_mk(p), garbage=4, deflate=True, no_new_id=True)
    files["Documents/Housing/lease.pdf"] = "2022-08-15"

    # 9. Markdown lecture notes
    write(ROOT / "Documents/School/MATH 136/lecture-07.md", (
        "# Lecture 7: Eigenvalues and eigenvectors\n\n"
        "An eigenvector v of A satisfies Av = λv. Find eigenvalues from det(A - λI) = 0.\n\n"
        "## Diagonalization\n\nA is diagonalizable when it has n linearly independent eigenvectors.\n"
        "Then A = PDP⁻¹ with eigenvalues on the diagonal of D.\n"))
    files["Documents/School/MATH 136/lecture-07.md"] = "2024-10-03"

    # 10. Code
    write(ROOT / "Code/tools/fuzzy_match.py", (
        '"""Rank strings by edit distance."""\n\n\n'
        "def levenshtein(a: str, b: str) -> int:\n"
        "    prev = list(range(len(b) + 1))\n"
        "    for i, ca in enumerate(a, 1):\n"
        "        cur = [i]\n"
        "        for j, cb in enumerate(b, 1):\n"
        "            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))\n"
        "        prev = cur\n"
        "    return prev[-1]\n\n\n"
        "def best_match(query: str, options: list[str]) -> str:\n"
        "    return min(options, key=lambda o: levenshtein(query.lower(), o.lower()))\n"))
    files["Code/tools/fuzzy_match.py"] = "2025-02-10"

    write(ROOT / "Code/scripts/backup-photos.ps1", (
        "# Mirror the photo library to the external drive every night\n"
        "$src = \"$env:USERPROFILE\\Pictures\"\n"
        "$dst = 'E:\\Backups\\Pictures'\n"
        "robocopy $src $dst /MIR /R:2 /W:5 /LOG+:$dst\\backup.log\n"))
    files["Code/scripts/backup-photos.ps1"] = "2025-08-30"

    # 11. Plain text, UTF-8 and a non-ASCII filename
    write(ROOT / "Documents/Notes/café menu ideas.md", (
        "# Café menu ideas\n\n- Cardamom buns\n- Oat milk flat white\n- Crème brûlée latte (seasonal)\n"))
    files["Documents/Notes/café menu ideas.md"] = "2025-11-02"

    write(ROOT / "Documents/Notes/banana bread.txt", (
        "Banana bread\n3 ripe bananas, 1/3 cup melted butter, 3/4 cup sugar, 1 egg,\n"
        "1 tsp baking soda, 1.5 cups flour. Bake 60 min at 350F.\n"))
    files["Documents/Notes/banana bread.txt"] = "2021-06-12"

    # 12. Legacy Windows-1252 encoded journal
    write(ROOT / "Documents/Notes/journal-2019.txt",
          "Moved into the dorm today. Felt na\xefve about how much stuff I brought.\n".encode("cp1252"))
    files["Documents/Notes/journal-2019.txt"] = "2019-09-03"

    # 13. A corrupt PDF (must fail cleanly, not crash the worker)
    write(ROOT / "Downloads/broken-statement.pdf", b"%PDF-1.7\n1 0 obj << /Type /Catalog >>\ngarbage\n")
    files["Downloads/broken-statement.pdf"] = "2024-12-01"

    for rel, date in files.items():
        set_mtime(ROOT / rel, date)
    print(f"wrote {len(files)} files to {ROOT}")


if __name__ == "__main__":
    main()
