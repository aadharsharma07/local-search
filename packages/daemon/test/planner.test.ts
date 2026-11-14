import { describe, expect, it } from "vitest";
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
