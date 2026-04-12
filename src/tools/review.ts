import { spawnCodex } from "../utils/spawn.js";
import { parseCodexOutput } from "../utils/parse.js";
import { checkErrorPatterns } from "../utils/errors.js";
import { loadPrompt, buildLengthLimit } from "../utils/prompts.js";
import { getGitRoot, getUncommittedDiff, getBranchDiff } from "../utils/git.js";
import { verifyDirectory } from "../utils/security.js";
import { resolveModel } from "../utils/model.js";
import { withModelFallback, HARD_TIMEOUT_CAP } from "../utils/retry.js";
import { getMcpServerOverride, willEnableServer } from "../utils/env.js";

export interface ReviewInput {
  uncommitted?: boolean;
  base?: string;
  focus?: string;
  quick?: boolean;
  model?: string;
  workingDirectory?: string;
  timeout?: number;
  maxResponseLength?: number;
  /**
   * MCP servers to enable for this review, using the CODEX_MCP_SERVERS grammar
   * (comma-separated list, "inherit", raw TOML, or empty string to disable all
   * non-required servers). Servers marked `required = true` in `config.toml`
   * (codex PR #10902) stay enabled regardless of the value — the bridge
   * refuses to disable them and will warn loudly if the caller's list would
   * have dropped one. When unset, agentic mode defaults to "serena" so symbol
   * navigation is available during review; quick mode defaults to disable-all
   * (empty string). Setting this explicitly overrides both the tool default
   * and the CODEX_MCP_SERVERS env var.
   */
  mcpServers?: string;
}

export interface ReviewResult {
  response: string;
  diffSource: "uncommitted" | "branch";
  base?: string;
  mode: "agentic" | "quick";
  model?: string;
  fallbackUsed?: boolean;
  timedOut: boolean;
}

/** Default timeout for agentic review (Codex explores repo in --full-auto). */
const AGENTIC_TIMEOUT = 300_000;

/** Default timeout for quick review (diff-only, single pass). */
const QUICK_TIMEOUT = 120_000;

/**
 * Agentic review prompt. Codex CLI runs in --full-auto with shell access.
 * It will run git diff, read files, follow imports.
 *
 * When `useSerenaPrompt` is true, loads the serena-aware variant that tells
 * Codex to prefer Serena MCP tools (get_symbols_overview, find_symbol,
 * find_referencing_symbols) over cat/grep. Callers should set this only when
 * the serena MCP server is actually enabled for the subprocess — otherwise
 * the LLM will try to call tools that don't exist.
 */
export function buildAgenticPrompt(
  diffSpec: string,
  focus?: string,
  maxResponseLength?: number,
  useSerenaPrompt = false,
): string {
  const file = useSerenaPrompt ? "review-agentic-with-serena.md" : "review-agentic.md";
  return loadPrompt(file, {
    DIFF_SPEC: diffSpec,
    FOCUS_SECTION: focus ? `## Focus Area\n\nPay special attention to: ${focus}` : "",
    LENGTH_LIMIT: buildLengthLimit(maxResponseLength),
  });
}

/**
 * Quick review prompt. Pre-computed diff, no repo exploration.
 */
export function buildQuickPrompt(diff: string, focus?: string, maxResponseLength?: number): string {
  return loadPrompt("review-quick.md", {
    DIFF: diff,
    FOCUS_SECTION: focus ? `Pay special attention to: ${focus}` : "",
    LENGTH_LIMIT: buildLengthLimit(maxResponseLength),
  });
}

/**
 * Execute a code review.
 *
 * Agentic (default): Spawns Codex CLI in --full-auto mode inside the repo.
 * The CLI runs git diff, reads files, explores codebase for context.
 *
 * Quick mode: Pre-computes the diff and sends it as text. Single-pass.
 */
export async function executeReview(input: ReviewInput): Promise<ReviewResult> {
  const { uncommitted = true, base, focus, quick = false, maxResponseLength } = input;
  const model = resolveModel(input.model);
  const defaultTimeout = quick ? QUICK_TIMEOUT : AGENTIC_TIMEOUT;
  const timeout = Math.min(input.timeout ?? defaultTimeout, HARD_TIMEOUT_CAP);

  const requestedDir = input.workingDirectory
    ? await verifyDirectory(input.workingDirectory)
    : process.cwd();
  const cwd = getGitRoot(requestedDir);

  // Resolve the effective CODEX_MCP_SERVERS value for this review:
  //   1. Explicit input.mcpServers wins (tool caller knows what they want).
  //   2. Otherwise CODEX_MCP_SERVERS env var, if set.
  //   3. Otherwise: agentic defaults to "serena" (symbol nav during review);
  //      quick stays disable-all (empty string).
  // When the value came from the implicit tool default (case 3), warnings for
  // unknown/required servers are suppressed — the user never asked for
  // anything, so yelling at them about the bridge's internal preferences is
  // noise.
  const envVal = process.env["CODEX_MCP_SERVERS"];
  const callerExplicit = input.mcpServers !== undefined || envVal !== undefined;
  const mcpServers =
    input.mcpServers ??
    (envVal !== undefined ? envVal : quick ? "" : "serena");
  const silentMcp = !callerExplicit;

  if (quick) {
    return executeQuickReview({ cwd, uncommitted, base, focus, model, timeout, maxResponseLength, mcpServers, silentMcp });
  }

  return executeAgenticReview({ cwd, uncommitted, base, focus, model, timeout, maxResponseLength, mcpServers, silentMcp });
}

interface InternalReviewInput {
  cwd: string;
  uncommitted: boolean;
  base?: string;
  focus?: string;
  model?: string;
  timeout: number;
  maxResponseLength?: number;
  mcpServers: string;
  silentMcp: boolean;
}

/**
 * Agentic review: Codex CLI runs with --full-auto inside the repo.
 * It has full autonomy to read files, run git commands, follow imports.
 */
async function executeAgenticReview(input: InternalReviewInput): Promise<ReviewResult> {
  const { cwd, uncommitted, base, focus, model, timeout, maxResponseLength, mcpServers, silentMcp } = input;

  let diffSpec: string;
  let diffSource: ReviewResult["diffSource"];

  if (base) {
    if (!/^[\w./-]+$/.test(base)) {
      throw new Error(`Invalid base ref: "${base}" — must be a valid git ref (alphanumeric, -, _, /, .)`);
    }
    diffSpec = `git diff ${base}...HEAD -U5`;
    diffSource = "branch";
  } else if (uncommitted) {
    diffSpec = "git diff HEAD -U5";
    diffSource = "uncommitted";
  } else {
    throw new Error("Either 'uncommitted' must be true or 'base' must be specified");
  }

  // Early exit if nothing to review
  try {
    const diff = base ? getBranchDiff(cwd, base) : getUncommittedDiff(cwd);
    if (!diff.trim()) {
      return {
        response: base
          ? `No diff found between ${base} and HEAD.`
          : "No uncommitted changes found.",
        diffSource,
        base,
        mode: "agentic",
        timedOut: false,
      };
    }
  } catch (e) {
    if (e instanceof Error && (e.message.includes("No uncommitted changes") || e.message.includes("No diff found"))) {
      return {
        response: e.message,
        diffSource,
        base,
        mode: "agentic",
        timedOut: false,
      };
    }
    throw e;
  }

  const useSerenaPrompt = willEnableServer(mcpServers, "serena");
  const prompt = buildAgenticPrompt(diffSpec, focus, maxResponseLength, useSerenaPrompt);

  const { result, fallbackUsed, fallbackModel } = await withModelFallback(
    model,
    (m, t) => {
      // --full-auto implies sandbox, don't combine with explicit --sandbox
      const args: string[] = ["exec", ...getMcpServerOverride(mcpServers, { silent: silentMcp })];
      if (m) args.push("--model", m);
      args.push("--full-auto", "--skip-git-repo-check");
      return spawnCodex({ args, cwd, stdin: prompt, timeout: t });
    },
    timeout,
  );

  const actualModel = fallbackUsed ? fallbackModel : model;

  if (result.timedOut) {
    return {
      response: `Review timed out after ${timeout / 1000}s. Try with quick: true for a faster, diff-only review.`,
      diffSource,
      base,
      mode: "agentic",
      model: actualModel,
      fallbackUsed: fallbackUsed || undefined,
      timedOut: true,
    };
  }

  checkErrorPatterns(result.exitCode, result.stderr);

  const parsed = parseCodexOutput(result.stdout, result.stderr);

  return {
    response: parsed.response,
    diffSource,
    base,
    mode: "agentic",
    model: actualModel,
    fallbackUsed: fallbackUsed || undefined,
    timedOut: false,
  };
}

/**
 * Quick review: pre-computed diff, single-pass, no repo exploration.
 */
async function executeQuickReview(input: InternalReviewInput): Promise<ReviewResult> {
  const { cwd, uncommitted, base, focus, model, timeout, maxResponseLength, mcpServers, silentMcp } = input;

  let diff: string;
  let diffSource: ReviewResult["diffSource"];

  try {
    if (base) {
      diff = getBranchDiff(cwd, base);
      diffSource = "branch";
    } else if (uncommitted) {
      diff = getUncommittedDiff(cwd);
      diffSource = "uncommitted";
    } else {
      throw new Error("Either 'uncommitted' must be true or 'base' must be specified");
    }
  } catch (e) {
    if (e instanceof Error && (e.message.includes("No uncommitted changes") || e.message.includes("No diff found"))) {
      return {
        response: e.message,
        diffSource: base ? "branch" : "uncommitted",
        base,
        mode: "quick",
        timedOut: false,
      };
    }
    throw e;
  }

  const fullPrompt = buildQuickPrompt(diff, focus, maxResponseLength);

  const { result, fallbackUsed, fallbackModel } = await withModelFallback(
    model,
    (m, t) => {
      const args: string[] = ["exec", ...getMcpServerOverride(mcpServers, { silent: silentMcp })];
      if (m) args.push("--model", m);
      args.push("--sandbox", "read-only", "--skip-git-repo-check");
      return spawnCodex({ args, cwd, stdin: fullPrompt, timeout: t });
    },
    timeout,
  );

  const actualModel = fallbackUsed ? fallbackModel : model;

  if (result.timedOut) {
    return {
      response: `Review timed out after ${timeout / 1000}s. The diff may be too large. Try reviewing a smaller scope.`,
      diffSource,
      base,
      mode: "quick",
      model: actualModel,
      fallbackUsed: fallbackUsed || undefined,
      timedOut: true,
    };
  }

  checkErrorPatterns(result.exitCode, result.stderr);

  const parsed = parseCodexOutput(result.stdout, result.stderr);

  return {
    response: parsed.response,
    diffSource,
    base,
    mode: "quick",
    model: actualModel,
    fallbackUsed: fallbackUsed || undefined,
    timedOut: false,
  };
}
