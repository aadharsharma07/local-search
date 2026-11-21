import { describe, expect, it } from "vitest";
import { parseShellFolders } from "../src/shared/platform.ts";

const REG = `
HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders
    AppData    REG_EXPAND_SZ    %USERPROFILE%\\AppData\\Roaming
    Desktop    REG_EXPAND_SZ    C:\\Users\\sam\\OneDrive\\Desktop
    My Pictures    REG_EXPAND_SZ    C:\\Users\\sam\\OneDrive\\Pictures
    Personal    REG_EXPAND_SZ    C:\\Users\\sam\\OneDrive\\Documents
    {374DE290-123F-4565-9164-39C4925E467B}    REG_EXPAND_SZ    %USERPROFILE%\\Downloads
`;

describe("parseShellFolders", () => {
  it("reads OneDrive-redirected folders and expands env vars", () => {
    expect(parseShellFolders(REG, { UserProfile: "C:\\Users\\sam" })).toEqual({
      Desktop: "C:\\Users\\sam\\OneDrive\\Desktop",
      Pictures: "C:\\Users\\sam\\OneDrive\\Pictures",
      Documents: "C:\\Users\\sam\\OneDrive\\Documents",
      Downloads: "C:\\Users\\sam\\Downloads",
    });
  });

  it("drops values whose variables can't be expanded", () => {
    expect(parseShellFolders(REG, {}).Downloads).toBeUndefined();
  });

  it("returns nothing for empty output", () => {
    expect(parseShellFolders("", {})).toEqual({});
  });
});
