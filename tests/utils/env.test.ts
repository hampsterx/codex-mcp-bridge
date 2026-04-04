import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { buildSubprocessEnv } from "../../src/utils/env.js";

describe("buildSubprocessEnv", () => {
  const origEnv = { ...process.env };

  beforeEach(() => {
    // Clear relevant env vars
    delete process.env["OPENAI_API_KEY"];
    delete process.env["OPENAI_BASE_URL"];
    delete process.env["OPENAI_ORG_ID"];
    delete process.env["CODEX_HOME"];
    delete process.env["CODEX_DEFAULT_MODEL"];
  });

  afterEach(() => {
    process.env = { ...origEnv };
  });

  it("always sets NO_COLOR and FORCE_COLOR", () => {
    const env = buildSubprocessEnv();
    expect(env["NO_COLOR"]).toBe("1");
    expect(env["FORCE_COLOR"]).toBe("0");
  });

  it("includes allowed OpenAI keys", () => {
    process.env["OPENAI_API_KEY"] = "sk-test-123";
    process.env["OPENAI_BASE_URL"] = "https://api.openai.com";
    const env = buildSubprocessEnv();
    expect(env["OPENAI_API_KEY"]).toBe("sk-test-123");
    expect(env["OPENAI_BASE_URL"]).toBe("https://api.openai.com");
  });

  it("includes system essentials", () => {
    process.env["HOME"] = "/home/test";
    process.env["PATH"] = "/usr/bin";
    const env = buildSubprocessEnv();
    expect(env["HOME"]).toBe("/home/test");
    expect(env["PATH"]).toBe("/usr/bin");
  });

  it("excludes non-allowlisted vars", () => {
    process.env["SECRET_KEY"] = "should-not-appear";
    process.env["OPENAI_CUSTOM_THING"] = "also-excluded";
    const env = buildSubprocessEnv();
    expect(env["SECRET_KEY"]).toBeUndefined();
    expect(env["OPENAI_CUSTOM_THING"]).toBeUndefined();
  });

  it("skips empty values", () => {
    process.env["OPENAI_API_KEY"] = "";
    const env = buildSubprocessEnv();
    expect(env["OPENAI_API_KEY"]).toBeUndefined();
  });
});
