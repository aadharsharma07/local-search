import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { installStartup, removeStartup, STARTUP_FILE, startupDir, startupScript } from "../src/startup.ts";

describe("lsd startup", () => {
  it("writes a hidden-window launcher with quotes escaped for VBScript", () => {
    const vbs = startupScript("C:\\Users\\me\\projects\\local-search", "C:\\Users\\me\\.local-search\\daemon.log");
    expect(vbs).toContain('Run "cmd /c cd /d ""C:\\Users\\me\\projects\\local-search"" && pnpm lsd serve >> ""C:\\Users\\me\\.local-search\\daemon.log"" 2>&1", 0, False');
    expect(vbs).toContain("\r\n");
  });

  it("installs into and removes from the Startup folder", () => {
    const dir = mkdtempSync(join(tmpdir(), "lsd-startup-"));
    const file = installStartup("/repo", "/data", dir);
    expect(file).toBe(join(dir, STARTUP_FILE));
    expect(readFileSync(file, "utf8")).toContain("pnpm lsd serve");
    expect(removeStartup(dir)).toBe(true);
    expect(existsSync(file)).toBe(false);
    expect(removeStartup(dir)).toBe(false);
  });

  it("finds the Startup folder from APPDATA", () => {
    expect(startupDir({ APPDATA: "/a" })).toBe(join("/a", "Microsoft", "Windows", "Start Menu", "Programs", "Startup"));
    expect(() => startupDir({})).toThrow(/only works on Windows/);
  });
});
