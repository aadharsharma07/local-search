"""JSON-lines protocol over stdin/stdout.

Request:  {"id": 1, "op": "extract", "path": "...", "ocr": "auto"}
          {"id": 2, "op": "engines"}
          {"id": 3, "op": "ping"}
Response: {"id": 1, "ok": true, "result": {...}} or {"id": 1, "ok": false, "error": "..."}

One request at a time. Timeouts, memory caps and restarts are the caller's job.
Run with: python -m lsworker.server
"""

from __future__ import annotations

import json
import os
import sys

from . import __version__, ocr
from .extract import extract


# Windows file attributes that mark OneDrive / cloud placeholders. Reading the contents of such a
# file triggers a download, so the indexer must treat them as metadata-only.
RECALL_ON_DATA_ACCESS = 0x400000
RECALL_ON_OPEN = 0x40000
OFFLINE = 0x1000
CLOUD_MASK = RECALL_ON_DATA_ACCESS | RECALL_ON_OPEN | OFFLINE


def cloud_attrs(paths: list[str]) -> dict:
    """Return the indexes of paths that are cloud placeholders. stat() never hydrates a file."""
    if sys.platform != "win32":
        return {"supported": False, "placeholders": []}
    hits = []
    for i, p in enumerate(paths):
        try:
            if os.stat(p, follow_symlinks=False).st_file_attributes & CLOUD_MASK:
                hits.append(i)
        except OSError:
            pass
    return {"supported": True, "placeholders": hits}


def handle(req: dict) -> dict:
    op = req.get("op")
    if op == "ping":
        return {"version": __version__, "python": sys.version.split()[0], "platform": sys.platform}
    if op == "engines":
        return {"ocr": ocr.available_engines()}
    if op == "cloudattrs":
        return cloud_attrs(req["paths"])
    if op == "extract":
        return extract(req["path"], req.get("ocr", "auto")).to_json()
    raise ValueError(f"unknown op {op!r}")


def main() -> None:
    # Force UTF-8 so Windows consoles never mangle paths or text.
    sys.stdout.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]
    sys.stdin.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        req_id = None
        try:
            req = json.loads(line)
            req_id = req.get("id")
            out = {"id": req_id, "ok": True, "result": handle(req)}
        except Exception as e:  # noqa: BLE001
            out = {"id": req_id, "ok": False, "error": f"{type(e).__name__}: {e}"}
        sys.stdout.write(json.dumps(out, ensure_ascii=False) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
