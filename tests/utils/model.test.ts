import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getDefaultModel, getFallbackModel, resolveModel } from "../../src/utils/model.js";

describe("model", () => {
  const origEnv = { ...process.env };

  beforeEach(() => {
    delete process.env["CODEX_DEFAULT_MODEL"];
    delete process.env["CODEX_FALLBACK_MODEL"];
  });

  afterEach(() => {
    process.env = { ...origEnv };
  });

  describe("getDefaultModel", () => {
    it("returns undefined when unset", () => {
      expect(getDefaultModel()).toBeUndefined();
    });

    it("returns the configured model", () => {
      process.env["CODEX_DEFAULT_MODEL"] = "gpt-4.1";
      expect(getDefaultModel()).toBe("gpt-4.1");
    });

    it("treats whitespace-only as unset", () => {
      process.env["CODEX_DEFAULT_MODEL"] = "   ";
      expect(getDefaultModel()).toBeUndefined();
    });
  });

  describe("getFallbackModel", () => {
    it("defaults to o3", () => {
      expect(getFallbackModel()).toBe("o3");
    });

    it("returns configured fallback", () => {
      process.env["CODEX_FALLBACK_MODEL"] = "gpt-4.1-mini";
      expect(getFallbackModel()).toBe("gpt-4.1-mini");
    });

    it("returns undefined when set to none", () => {
      process.env["CODEX_FALLBACK_MODEL"] = "none";
      expect(getFallbackModel()).toBeUndefined();
    });

    it("is case-insensitive for none", () => {
      process.env["CODEX_FALLBACK_MODEL"] = "NONE";
      expect(getFallbackModel()).toBeUndefined();
    });
  });

  describe("resolveModel", () => {
    it("uses explicit model when provided", () => {
      process.env["CODEX_DEFAULT_MODEL"] = "o3";
      expect(resolveModel("gpt-4.1")).toBe("gpt-4.1");
    });

    it("falls back to env default", () => {
      process.env["CODEX_DEFAULT_MODEL"] = "o3";
      expect(resolveModel()).toBe("o3");
    });

    it("returns undefined when no model configured", () => {
      expect(resolveModel()).toBeUndefined();
    });
  });
});
