import { mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_EXCLUDES, loadDaemonConfig } from "../src/config.ts";

describe("daemon config", () => {
  it("uses defaults when the file is missing", () => {
    const c = loadDaemonConfig(join(tmpdir(), "no-such-local-search-config.yaml"));
    expect(c.excludeDirs).toEqual(DEFAULT_EXCLUDES);
    expect(c.roots).toHaveLength(4);
    expect(c.rerank).toBe(false);
    expect(c.expand).toBe(false);
  });

  it("adds excludes to the built-in list, expands ~ and reads switches", () => {
    const dir = mkdtempSync(join(tmpdir(), "ls-cfg-"));
    const file = join(dir, "config.yaml");
    writeFileSync(file, "roots:\n  - ~/Stuff\nexcludeDirs:\n  - WorkThings\nrerank: true\nport: 9000\n");
    const c = loadDaemonConfig(file);
    expect(c.roots).toEqual([join(homedir(), "Stuff")]);
    expect(c.excludeDirs).toEqual([...DEFAULT_EXCLUDES, "WorkThings"]);
    expect(c.rerank).toBe(true);
    expect(c.expand).toBe(false);
    expect(c.port).toBe(9000);
  });
});
