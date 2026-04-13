import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getDefaultModel, getFallbackModel, resolveModel, getSupportedModels } from "../../src/utils/model.js";

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

  describe("getSupportedModels", () => {
    it("returns all models with expected fields", () => {
      const models = getSupportedModels();
      expect(models.length).toBeGreaterThanOrEqual(3);
      for (const m of models) {
        expect(m).toHaveProperty("id");
        expect(m).toHaveProperty("tier");
        expect(m).toHaveProperty("description");
        expect(m).toHaveProperty("isDefault");
        expect(["fast", "standard", "powerful"]).toContain(m.tier);
      }
    });

    it("includes gpt-4.1, o3, and gpt-5.4", () => {
      const ids = getSupportedModels().map((m) => m.id);
      expect(ids).toContain("gpt-4.1");
      expect(ids).toContain("o3");
      expect(ids).toContain("gpt-5.4");
    });

    it("marks no model as default when CODEX_DEFAULT_MODEL is unset", () => {
      const models = getSupportedModels();
      expect(models.every((m) => m.isDefault === false)).toBe(true);
    });

    it("marks the matching model as default when CODEX_DEFAULT_MODEL is set", () => {
      process.env["CODEX_DEFAULT_MODEL"] = "o3";
      const models = getSupportedModels();
      const defaultModels = models.filter((m) => m.isDefault);
      expect(defaultModels).toHaveLength(1);
      expect(defaultModels[0].id).toBe("o3");
    });

    it("marks no model as default when CODEX_DEFAULT_MODEL is not in the list", () => {
      process.env["CODEX_DEFAULT_MODEL"] = "some-unknown-model";
      const models = getSupportedModels();
      expect(models.every((m) => m.isDefault === false)).toBe(true);
    });
  });
});
