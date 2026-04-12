import { spawnCodex } from "../utils/spawn.js";
import { parseCodexOutput } from "../utils/parse.js";
import { checkErrorPatterns } from "../utils/errors.js";
import { loadPrompt, buildLengthLimit } from "../utils/prompts.js";
import { verifyDirectory } from "../utils/security.js";
import { resolveModel } from "../utils/model.js";
import { withModelFallback, HARD_TIMEOUT_CAP } from "../utils/retry.js";
import { getMcpServerOverride } from "../utils/env.js";

export interface SearchInput {
  query: string;
  model?: string;
  workingDirectory?: string;
  timeout?: number;
  maxResponseLength?: number;
}

export interface SearchResult {
  response: string;
  model?: string;
  fallbackUsed?: boolean;
  timedOut: boolean;
}

/** Default timeout for search queries. */
const SEARCH_TIMEOUT = 120_000;

/**
 * Execute a web search via Codex CLI.
 *
 * Per plan: `codex --search exec --skip-git-repo-check "prompt"`
 * The --search flag must come before the exec subcommand.
 */
export async function executeSearch(input: SearchInput): Promise<SearchResult> {
  const { query, maxResponseLength } = input;
  const model = resolveModel(input.model);
  const timeout = Math.min(input.timeout ?? SEARCH_TIMEOUT, HARD_TIMEOUT_CAP);

  const cwd = input.workingDirectory
    ? await verifyDirectory(input.workingDirectory)
    : process.cwd();

  const prompt = loadPrompt("search.md", {
    QUERY: query,
    LENGTH_LIMIT: buildLengthLimit(maxResponseLength) || "Provide a focused synthesis. Aim for 500-1500 words unless the topic clearly warrants more.",
  });

  const { result, fallbackUsed, fallbackModel } = await withModelFallback(
    model,
    (m, t) => {
      // codex --search exec --skip-git-repo-check "prompt"
      // --search goes before exec subcommand
      const args: string[] = ["--search", "exec", ...getMcpServerOverride()];
      if (m) args.push("--model", m);
      args.push("--skip-git-repo-check");
      return spawnCodex({ args, cwd, stdin: prompt, timeout: t });
    },
    timeout,
  );

  if (result.timedOut) {
    return {
      response: `Search timed out after ${timeout / 1000}s. Try a more specific query or increase the timeout.`,
      model: fallbackUsed ? fallbackModel : model,
      timedOut: true,
    };
  }

  checkErrorPatterns(result.exitCode, result.stderr);

  const parsed = parseCodexOutput(result.stdout, result.stderr);

  return {
    response: parsed.response,
    model: fallbackUsed ? fallbackModel : model,
    fallbackUsed: fallbackUsed || undefined,
    timedOut: false,
  };
}
