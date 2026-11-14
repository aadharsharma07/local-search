import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { chunkText } from "@local-search/daemon/shared/chunk";
import { sample } from "../src/corpus.ts";
import { kindFor } from "@local-search/daemon/shared/kinds";
import { hostOf, parseZoneIdentifier, readOrigin } from "@local-search/daemon/shared/platform";
import { quantile } from "../src/report.ts";
import { parseQmdJson } from "../src/spikes/s6.ts";
import { wordiness } from "../src/spikes/s5.ts";
import { scoreRankings } from "@local-search/daemon/shared/testset";
import { walkAll } from "@local-search/daemon/shared/walk";

describe("walk", () => {
  it("skips excluded folders, Office temp files and links", () => {
    const root = mkdtempSync(join(tmpdir(), "fk-walk-"));
    mkdirSync(join(root, "a", "node_modules"), { recursive: true });
    writeFileSync(join(root, "a", "keep.PDF"), "x");
    writeFileSync(join(root, "a", "~$draft.docx"), "x");
    writeFileSync(join(root, "a", "node_modules", "skip.js"), "x");
    let linked = false;
    try {
      symlinkSync(join(root, "a"), join(root, "loop"), process.platform === "win32" ? "junction" : "dir");
      linked = true;
    } catch {
      /* creating links can need privileges on Windows */
    }
    const { files, stats } = walkAll([root], ["node_modules"]);
    expect(files.map((f) => f.ext)).toEqual([".pdf"]);
    expect(stats.excludedDirs).toBe(1);
    if (linked) expect(stats.links).toBe(1);
  });

  it("handles a missing root without throwing", () => {
    const { files, stats } = walkAll([join(tmpdir(), "does-not-exist-fk")], []);
    expect(files).toHaveLength(0);
    expect(stats.denied).toBe(1);
  });

  it.runIf(process.platform === "win32")("handles paths longer than 260 characters", () => {
    const root = mkdtempSync(join(tmpdir(), "fk-long-"));
    let dir = root;
    while (dir.length < 300) dir = join(dir, "a-fairly-long-folder-name");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "deep.txt"), "x");
    const { files } = walkAll([root], []);
    expect(files).toHaveLength(1);
    expect(files[0]!.path.length).toBeGreaterThan(260);
  });
});

describe("origin", () => {
  it("parses a Zone.Identifier stream", () => {
    const o = parseZoneIdentifier(
      "﻿[ZoneTransfer]\r\nZoneId=3\r\nReferrerUrl=https://shop.example/orders\r\nHostUrl=https://cdn.shop.example/r/88123.pdf?sig=a=b\r\n",
    );
    expect(o).toEqual({ zoneId: 3, referrerUrl: "https://shop.example/orders", hostUrl: "https://cdn.shop.example/r/88123.pdf?sig=a=b" });
    expect(hostOf(o.hostUrl)).toBe("cdn.shop.example");
    expect(hostOf("not a url")).toBeNull();
  });

  it.runIf(process.platform === "win32")("reads Zone.Identifier from a real file", () => {
    const dir = mkdtempSync(join(tmpdir(), "fk-zone-"));
    const f = join(dir, "download.pdf");
    writeFileSync(f, "x");
    writeFileSync(`${f}:Zone.Identifier`, "[ZoneTransfer]\r\nZoneId=3\r\nHostUrl=https://example.com/a.pdf\r\n");
    expect(readOrigin(f)?.hostUrl).toBe("https://example.com/a.pdf");
    expect(readOrigin(join(dir, "missing.pdf"))).toBeNull();
  });
});

describe("chunker", () => {
  it("returns nothing for blank text and one chunk for short text", () => {
    expect(chunkText("   \n ")).toEqual([]);
    expect(chunkText("short note")).toEqual([{ pos: 0, text: "short note" }]);
  });

  it("covers long text with overlapping chunks that prefer headings", () => {
    const para = "word ".repeat(300).trim();
    const text = [`# One\n\n${para}`, `## Two\n\n${para}`, `## Three\n\n${para}`, `## Four\n\n${para}`].join("\n\n");
    const chunks = chunkText(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.text.length).toBeLessThanOrEqual(3600);
    // Cuts land just before a heading (the next chunk then starts with the overlap).
    const cutBeforeHeading = chunks.slice(0, -1).some((c) => {
      const end = text.indexOf(c.text, c.pos) + c.text.length;
      return /^\s*#/.test(text.slice(end));
    });
    expect(cutBeforeHeading).toBe(true);
    const last = chunks.at(-1)!;
    expect(text.endsWith(last.text)).toBe(true);
  });
});

describe("scoring", () => {
  it("computes recall@5 and MRR, ignoring case and separators", () => {
    const qs = [
      { q: "a", expected: ["/x/A.pdf"] },
      { q: "b", expected: ["/x/b.pdf"] },
      { q: "c", expected: ["/x/c.pdf"] },
    ];
    const s = scoreRankings(qs, [["/x/a.pdf"], ["1", "2", "3", "4", "5", "/x/b.pdf"], []]);
    expect(s.recallAtK).toBeCloseTo(1 / 3);
    expect(s.mrr).toBeCloseTo((1 + 1 / 6) / 3);
    expect(s.perQuery.map((p) => p.hitAt)).toEqual([1, 6, null]);
  });
});

describe("helpers", () => {
  it("maps kinds", () => {
    expect(kindFor(".PDF")).toBe("document");
    expect(kindFor(".heic")).toBe("media");
    expect(kindFor(".zip")).toBe("archive");
    expect(kindFor(".xyz")).toBe("other");
  });
  it("samples deterministically", () => {
    const xs = Array.from({ length: 100 }, (_, i) => i);
    expect(sample(xs, 5)).toEqual(sample(xs, 5));
    expect(new Set(sample(xs, 50)).size).toBe(50);
  });
  it("quantiles", () => {
    expect(quantile([5, 1, 3], 0.5)).toBe(3);
    expect(Number.isNaN(quantile([], 0.5))).toBe(true);
  });
  it("scores text quality", () => {
    expect(wordiness("Amount due by February 8, 2024: $84.12")).toBeGreaterThan(0.8);
    expect(wordiness("~~ |/|| ;; ::")).toBeLessThan(0.3);
  });
  it("parses qmd JSON results to exported document numbers", () => {
    const out = 'Loading…\n[{"file":"qmd://s6/12.md","score":0.9},{"file":"qmd://s6/3.md"},{"file":"qmd://s6/12.md"}]';
    expect(parseQmdJson(out)).toEqual([12, 3]);
    expect(parseQmdJson("no results")).toEqual([]);
  });
});
