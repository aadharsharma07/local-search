import { describe, expect, it } from "vitest";
import { openDb } from "../src/db/index.ts";
import { extractorTag, requeueOutdated } from "../src/ingest/index.ts";
import { search, termWeights } from "../src/search/index.ts";
import { matchesPart, nameParts, queryTerms, stem } from "../src/shared/text.ts";

type DB = ReturnType<typeof openDb>;

function seed(db: DB, path: string, text: string, mtime = 0) {
  const hash = `h:${path}`;
  db.prepare("INSERT INTO contents(hash, text, extractor, extracted_at) VALUES (?, ?, 'test', 0)").run(hash, text);
  db.prepare("INSERT INTO chunks(content_hash, seq, pos, text) VALUES (?, 0, 0, ?)").run(hash, text);
  db.prepare(
    "INSERT INTO files(path, content_hash, size, mtime, ext, kind, state, first_seen) VALUES (?, ?, 1, ?, '.pdf', 'document', 'indexed', 0)",
  ).run(path, hash, mtime);
}

describe("query and name text", () => {
  it("keeps distinctive words and drops filler", () => {
    expect(queryTerms("the resume i made for acme")).toEqual(["resume", "acme"]);
    expect(queryTerms("QX7P2L")).toEqual(["qx7p2l"]);
    expect(queryTerms("the")).toEqual(["the"]); // only filler: keep it rather than nothing
  });

  it("stems plurals and possessives only", () => {
    expect(stem("resumes")).toBe("resume");
    expect(stem("invoices")).toBe("invoice");
    expect(stem("Jane's")).toBe("jane");
    expect(stem("glass")).toBe("glass");
    expect(stem("status")).toBe("status");
  });

  it("splits file names into parts", () => {
    const parts = nameParts("Jane_s_Resume___acme.pdf");
    for (const p of ["jane", "resume", "acme", "pdf"]) expect(parts.has(p)).toBe(true);
    expect(nameParts("taxReturn2023.pdf").has("return")).toBe(true);
    expect(nameParts("taxReturn2023.pdf").has("2023")).toBe(true);
    expect(matchesPart("screenshot", nameParts("Screenshots"))).toBe(true);
  });
});

describe("extractor versions", () => {
  it("queues only files whose text came from another extractor version", () => {
    const db = openDb(":memory:");
    seed(db, "/a.pdf", "old");
    seed(db, "/b.pdf", "new");
    db.prepare("UPDATE contents SET extractor = 'lsworker' WHERE hash = 'h:/a.pdf'").run();
    db.prepare("UPDATE contents SET extractor = 'lsworker/0.2.0 +ocr:windows' WHERE hash = 'h:/b.pdf'").run();
    expect(requeueOutdated(db, extractorTag("0.2.0"))).toBe(1);
    const states = db.prepare("SELECT path, state FROM files ORDER BY path").all();
    expect(states).toEqual([
      { path: "/a.pdf", state: "stale" },
      { path: "/b.pdf", state: "indexed" },
    ]);
  });
});

describe("search ranking", () => {
  const resumeText = "Jane Doe resume. Experience: software engineer. Education: university. Skills: TypeScript.";
  const filler = (i: number) => `This is the note ${i} I made for the group, with some of my ideas for it.`;

  function build() {
    const db = openDb(":memory:");
    seed(db, "/d/Jane_Resume.pdf", resumeText);
    seed(db, "/d/Jane_s_Resume___october.pdf", resumeText + " October.");
    seed(db, "/d/Jane_s_Resume___acme.pdf", resumeText + " Projects.");
    for (let i = 0; i < 12; i++) seed(db, `/d/note-${i}.pdf`, filler(i));
    return db;
  }

  it("weights rare terms above common ones", () => {
    const db = build();
    const w = termWeights(db, ["made", "resume", "acme"]);
    expect(w.get("acme")!).toBeGreaterThan(w.get("resume")!);
    expect(w.get("resume")!).toBeGreaterThan(w.get("made")!);
  });

  it("finds a file by its distinctive name words despite filler in the query", async () => {
    const db = build();
    const hits = await search(db, null, "the resume i made for acme");
    expect(hits[0]!.paths[0]).toBe("/d/Jane_s_Resume___acme.pdf");
    expect(hits[0]!.trace.filename?.rank).toBe(1);
  });

  it("does not let filler words pull in unrelated notes", async () => {
    const db = build();
    const top3 = (await search(db, null, "the resume i made for acme", { limit: 3 })).map((h) => h.paths[0]);
    expect(top3.every((p) => p!.includes("Resume"))).toBe(true);
  });
});

describe("query plan in ranking", () => {
  const t = (iso: string) => new Date(iso).getTime();
  const now = new Date("2026-11-12T12:00:00");
  function build() {
    const db = openDb(":memory:");
    seed(db, "/d/Jane_Resume.pdf", "Jane Doe. Experience and education.", t("2026-03-05"));
    seed(db, "/d/Jane_Resume_bank.pdf", "Jane Doe. Experience, education, banking.", t("2026-03-22"));
    seed(db, "/d/Jane_Resume_final.pdf", "Jane Doe. Experience, education, projects.", t("2026-05-12"));
    seed(db, "/d/Jane_Resume_2025.pdf", "Jane Doe. Education.", t("2025-04-11"));
    for (let i = 0; i < 8; i++) seed(db, `/d/report-${i}.pdf`, `Quarterly report ${i} with experience notes.`, t("2026-05-20"));
    return db;
  }

  it("ties equal name matches instead of ranking by path length", async () => {
    const hits = await search(build(), null, "resume", { now });
    const ranks = hits.filter((h) => h.paths[0]!.includes("Resume")).map((h) => h.trace.filename?.rank);
    expect(new Set(ranks)).toEqual(new Set([1]));
  });

  it("puts the newest matching file first for 'latest'", async () => {
    const hits = await search(build(), null, "my most up to date resume", { now });
    expect(hits[0]!.paths[0]).toBe("/d/Jane_Resume_final.pdf");
    expect(hits[0]!.trace.plan?.recency).toBeGreaterThan(0);
  });

  it("puts the oldest first for 'original'", async () => {
    const hits = await search(build(), null, "the original resume", { now });
    expect(hits[0]!.paths[0]).toBe("/d/Jane_Resume_2025.pdf");
  });

  it("prefers dates inside the window, then just before it with 'or a little earlier'", async () => {
    const hits = await search(build(), null, "resume from april 2026 or a little earlier", { now });
    expect(hits[0]!.paths[0]).toBe("/d/Jane_Resume_bank.pdf"); // 10 days before April
    expect(hits[0]!.trace.plan?.time).toBeGreaterThan(0);
  });
});
