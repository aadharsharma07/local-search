import { describe, expect, it } from "vitest";
import { plan, timeFit } from "../src/planner/index.ts";
import { detectOrigin, detectTime, detectType } from "../src/planner/rules.ts";

const now = new Date("2026-11-12T12:00:00");

describe("planner rules", () => {
  it("detects time constraints, including phrasings chrono misses", () => {
    for (const q of ["receipts from 2021", "photos from last summer", "notes two weeks ago", "bill for march", "the thing I saved yesterday"])
      expect(detectTime(q, now), q).toBe(true);
    for (const q of ["my resume", "banana bread recipe", "may I see the lease", "python sort function"])
      expect(detectTime(q, now), q).toBe(false);
  });

  it("detects where a file came from", () => {
    expect(detectOrigin("the pdf I downloaded from the bank")).toBe(true);
    expect(detectOrigin("form my landlord emailed me")).toBe(true);
    expect(detectOrigin("screenshot of the error")).toBe(true);
    expect(detectOrigin("my lease agreement")).toBe(false);
  });

  it("detects the kind of file, or unspecified", () => {
    expect(detectType("photos of the cat")).toBe("image");
    expect(detectType("python script for renaming")).toBe("code");
    expect(detectType("receipt for the monitor")).toBe("document");
    expect(detectType("meeting notes")).toBe("text");
    expect(detectType("hotel in Montreal")).toBe("unspecified");
  });
});

describe("query plan", () => {
  const d = (s: string) => new Date(s).getTime();

  it("turns time phrases into windows", () => {
    const sept = plan("the invoice from september 2026", now).time!;
    expect(sept.from).toBe(d("2026-09-01T00:00:00"));
    expect(sept.to).toBe(d("2026-10-01T00:00:00"));
    const year = plan("taxes 2023", now).time!;
    expect([year.from, year.to]).toEqual([d("2023-01-01T00:00:00"), d("2024-01-01T00:00:00")]);
    const summer = plan("photos from last summer", now).time!;
    expect([summer.from, summer.to]).toEqual([d("2026-06-01T00:00:00"), d("2026-09-01T00:00:00")]);
    expect(plan("my lease", now).time).toBeUndefined();
  });

  it("reads which way 'a little earlier' leans", () => {
    expect(plan("cv from september 2026 or a little earlier", now).time!.lean).toBe("before");
    expect(plan("cv from september 2026", now).time!.lean).toBeUndefined();
  });

  it("detects recency only when no time is given, and drops it from the terms", () => {
    const p = plan("my most up to date cv", now);
    expect(p.recency).toBe("newest");
    expect(p.terms).toEqual(["cv"]);
    expect(plan("the original contract", now).recency).toBe("oldest");
    const old = plan("my old cv from 2024", now);
    expect(old.recency).toBeUndefined(); // the year decides
    expect(old.terms).toEqual(["cv"]);
  });

  it("maps code to unspecified and keeps screenshots apart from download origin", () => {
    expect(plan("python script for renaming", now).type).toBe("unspecified");
    const s = plan("screenshot of my profile", now);
    expect(s.screenshot).toBe(true);
    expect(s.type).toBe("image");
    expect(s.origin).toBe(false);
    expect(plan("the pdf I downloaded from the bank", now).origin).toBe(true);
  });

  it("scores dates by fit, with a lean", () => {
    const w = { from: d("2026-09-01"), to: d("2026-10-01"), text: "september 2026" };
    expect(timeFit(d("2026-09-15"), w)).toBe(1);
    const before = { ...w, lean: "before" as const };
    expect(timeFit(d("2026-08-20"), before)).toBeGreaterThan(timeFit(d("2026-10-12"), before));
  });
});
