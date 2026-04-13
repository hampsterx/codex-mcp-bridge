import { describe, it, expect, afterEach } from "vitest";
import { escapeForCmd, isWindows, escapeArg } from "../../src/utils/windows.js";

const originalPlatform = process.platform;

afterEach(() => {
  Object.defineProperty(process, "platform", { value: originalPlatform, writable: true });
});

describe("escapeForCmd", () => {
  it("escapes percent signs", () => {
    expect(escapeForCmd("100%")).toBe("100%%");
  });

  it("escapes double quotes", () => {
    expect(escapeForCmd('say "hello"')).toBe('say ""hello""');
  });

  it("escapes both percent and quotes together", () => {
    expect(escapeForCmd('50% "done"')).toBe('50%% ""done""');
  });

  it("returns unchanged string with no special chars", () => {
    expect(escapeForCmd("normal text")).toBe("normal text");
  });

  it("handles empty string", () => {
    expect(escapeForCmd("")).toBe("");
  });

  it("handles multiple consecutive percents", () => {
    expect(escapeForCmd("%%")).toBe("%%%%");
  });
});

describe("isWindows", () => {
  it("returns true on win32", () => {
    Object.defineProperty(process, "platform", { value: "win32", writable: true });
    expect(isWindows()).toBe(true);
  });

  it("returns false on linux", () => {
    Object.defineProperty(process, "platform", { value: "linux", writable: true });
    expect(isWindows()).toBe(false);
  });

  it("returns false on darwin", () => {
    Object.defineProperty(process, "platform", { value: "darwin", writable: true });
    expect(isWindows()).toBe(false);
  });
});

describe("escapeArg", () => {
  it("escapes on Windows", () => {
    Object.defineProperty(process, "platform", { value: "win32", writable: true });
    expect(escapeArg('100% "done"')).toBe('100%% ""done""');
  });

  it("passes through on non-Windows", () => {
    Object.defineProperty(process, "platform", { value: "linux", writable: true });
    expect(escapeArg('100% "done"')).toBe('100% "done"');
  });
});
