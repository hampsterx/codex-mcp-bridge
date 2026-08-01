import { tmpdir } from "node:os";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { spawnCodex } from "../utils/spawn.js";
import { parseCodexOutput, type CodexUsage } from "../utils/parse.js";
import { checkErrorPatterns } from "../utils/errors.js";
import { loadPrompt, buildLengthLimit } from "../utils/prompts.js";
import { resolveModel } from "../utils/model.js";
import { withModelFallback, HARD_TIMEOUT_CAP } from "../utils/retry.js";
import { getMcpServerOverride } from "../utils/env.js";

export interface QueryInput {
  prompt: string;
  context?: string;
  model?: string;
  reasoningEffort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
  timeout?: number;
  maxResponseLength?: number;
}

export interface QueryResult {
  response: string;
  model?: string;
  fallbackUsed?: boolean;
  usage?: CodexUsage;
  timedOut: boolean;
}

/** Default timeout for query operations. */
const QUERY_TIMEOUT = 60_000;

/**
 * Execute a lightweight, non-agentic query via Codex CLI.
 *
 * Spawns in an isolated temp directory so the bridge's own repo doesn't
 * leak into subprocess context. No file reading, no path security,
 * no session management.
 */
export async function executeQuery(input: QueryInput): Promise<QueryResult> {
  const { prompt, context, reasoningEffort, maxResponseLength } = input;
  const model = resolveModel(input.model);
  const timeout = Math.min(input.timeout ?? QUERY_TIMEOUT, HARD_TIMEOUT_CAP);

  const stdinPrompt = loadPrompt("query.md", {
    PROMPT: prompt,
    CONTEXT: context ?? "No additional context provided.",
    LENGTH_LIMIT: buildLengthLimit(maxResponseLength) || "Be concise and direct.",
  });

  // Spawn in an isolated temp dir so Codex doesn't pick up the bridge's
  // own AGENTS.md/CODEX.md or any repo context.
  const tempDir = await mkdtemp(join(tmpdir(), "codex-query-"));

  try {
    const { result, fallbackUsed, fallbackModel } = await withModelFallback(
      model,
      (m, t) => {
        const args: string[] = [
          "exec",
          "--json",
          "--sandbox", "read-only",
          "--skip-git-repo-check",
          "--ephemeral",
          // Disable all non-required MCP servers
          ...getMcpServerOverride("", { silent: true }),
        ];
        if (m) args.push(`--model=${m}`);
        if (reasoningEffort) args.push("-c", `model_reasoning_effort="${reasoningEffort}"`);
        return spawnCodex({ args, cwd: tempDir, stdin: stdinPrompt, timeout: t });
      },
      timeout,
    );

    if (result.timedOut) {
      return {
        response: `Query timed out after ${timeout / 1000}s. Try a simpler prompt or increase the timeout.`,
        model: fallbackUsed ? fallbackModel : model,
        timedOut: true,
      };
    }

    checkErrorPatterns(result.exitCode, result.stderr, result.stdout);

    const parsed = parseCodexOutput(result.stdout, result.stderr);

    return {
      response: parsed.response,
      model: fallbackUsed ? fallbackModel : model,
      fallbackUsed: fallbackUsed || undefined,
      usage: parsed.usage,
      timedOut: false,
    };
  } finally {
    // Clean up temp dir — fire and forget
    rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}
