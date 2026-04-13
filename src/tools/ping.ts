import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import {
  findCodexBinary,
  getActiveCount,
  getMaxConcurrent,
  getQueueDepth,
} from "../utils/spawn.js";
import { buildSubprocessEnv } from "../utils/env.js";
import { getDefaultModel, getFallbackModel, getSupportedModels, type ModelInfo } from "../utils/model.js";

const require = createRequire(import.meta.url);
const PKG_VERSION: string = (require("../../package.json") as { version: string }).version;

export interface PingResult {
  cliFound: boolean;
  version: string | null;
  authStatus: "ok" | "missing" | "unknown";
  defaultModel: string | null;
  fallbackModel: string | null;
  supportedModels: ModelInfo[];
  serverVersion: string;
  nodeVersion: string;
  maxConcurrent: number;
  activeCount: number;
  queueDepth: number;
}

/**
 * Detect auth status by checking environment variables.
 * Codex CLI authenticates via OPENAI_API_KEY or `codex auth login` (stored locally).
 */
function detectAuthStatus(): PingResult["authStatus"] {
  const env = buildSubprocessEnv();

  if (env["OPENAI_API_KEY"]) {
    return "ok";
  }

  // Codex also supports login-based auth, but we can't easily detect that
  // without spawning the CLI. Return unknown, ping tool output will guide the user.
  return "unknown";
}

/**
 * Health check and capability detection.
 * Checks if Codex CLI is installed and reports versions.
 */
export async function executePing(): Promise<PingResult> {
  const binary = findCodexBinary();

  // Build the base result once; error paths spread-override specific fields.
  const base: PingResult = {
    cliFound: false,
    version: null,
    authStatus: "unknown",
    defaultModel: getDefaultModel() ?? null,
    fallbackModel: getFallbackModel() ?? null,
    supportedModels: getSupportedModels(),
    serverVersion: PKG_VERSION,
    nodeVersion: process.version,
    maxConcurrent: getMaxConcurrent(),
    activeCount: getActiveCount(),
    queueDepth: getQueueDepth(),
  };

  try {
    const output = execFileSync(binary, ["--version"], {
      encoding: "utf8",
      timeout: 10_000,
    }).trim();
    base.cliFound = true;
    base.version = output;
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === "ENOENT") {
      return { ...base, authStatus: "missing" };
    }
    // Binary exists but failed (EACCES, timeout, crash).
    // Return early so auth detection doesn't run against a broken CLI.
    return { ...base, cliFound: true };
  }

  base.authStatus = detectAuthStatus();
  return base;
}
