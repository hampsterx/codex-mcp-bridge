import { execFileSync } from "node:child_process";

export interface DiffStat {
  files: number;
  insertions: number;
  deletions: number;
}

export type DiffSpec = { type: "uncommitted" } | { type: "branch"; base: string };

/**
 * Validate a git base ref to prevent shell injection or path traversal.
 * Allows common revspec characters: alphanumeric, `-`, `_`, `/`, `.`, `~`, `^`.
 * These cover branch paths (origin/main) and ancestry syntax (HEAD~1, main^).
 *
 * Excludes `:` because tree-ish refs (v1.0:path) don't work with the
 * `base...HEAD` symmetric-difference syntax used by the review / assess
 * tools. Subprocess spawning with shell: false prevents actual injection,
 * so this is defense-in-depth.
 *
 * Shared by `review` and `assess` so both accept the same ref grammar.
 * Previously the two utilities disagreed, causing `assess({ base: "HEAD~1" })`
 * to fail even though the corresponding `review` call worked.
 */
export function validateBaseRef(base: string): void {
  if (base.startsWith("-")) {
    throw new Error(
      `Invalid base ref: "${base}" — must not start with - (interpreted as git option)`,
    );
  }
  if (!/^[\w./~^-]+$/.test(base)) {
    throw new Error(
      `Invalid base ref: "${base}" — must be a valid git ref (alphanumeric, -, _, /, ., ~, ^)`,
    );
  }
}

/**
 * Parse `git diff --numstat` output into a DiffStat summary.
 *
 * Binary files (`-\t-\t<path>`) contribute to the file count but not to
 * line counts. Renames (`{old => new}` in the path) count as a single
 * file. Exported for unit testing.
 */
export function parseNumstat(output: string): DiffStat {
  const stat: DiffStat = { files: 0, insertions: 0, deletions: 0 };
  for (const rawLine of output.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    const parts = line.split("\t");
    if (parts.length < 3) continue;
    stat.files += 1;
    const [ins, del] = parts;
    if (ins !== "-") stat.insertions += parseInt(ins!, 10) || 0;
    if (del !== "-") stat.deletions += parseInt(del!, 10) || 0;
  }
  return stat;
}

/**
 * Get numstat summary for a diff spec. Uses `git diff HEAD` for the
 * uncommitted case so the stat matches what the agentic review prompt
 * actually executes (`git diff HEAD -U5`). Returns undefined on failure
 * (non-git dir, empty diff, etc.) rather than throwing.
 */
export function getDiffStat(cwd: string, spec: DiffSpec): DiffStat | undefined {
  const run = (refArgs: string[]): string =>
    execFileSync("git", ["-C", cwd, "diff", "--numstat", ...refArgs], {
      encoding: "utf8",
      timeout: 30_000,
    });

  try {
    const output = spec.type === "branch"
      ? run([`${spec.base}...HEAD`])
      : run(["HEAD"]);
    const stat = parseNumstat(output);
    return stat.files > 0 ? stat : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Get the list of changed file paths for a diff spec.
 *
 * Uses `git diff --name-only`, one path per line. Returns an empty array
 * when there is no diff. Throws on bad refs or git errors so callers can
 * distinguish "no changes" from "couldn't read diff".
 */
export function getDiffFiles(cwd: string, spec: DiffSpec): string[] {
  const run = (refArgs: string[]): string =>
    execFileSync("git", ["-C", cwd, "diff", "--name-only", ...refArgs], {
      encoding: "utf8",
      timeout: 30_000,
    });

  try {
    let raw: string;
    if (spec.type === "branch") {
      validateBaseRef(spec.base);
      raw = run([`${spec.base}...HEAD`]);
    } else {
      raw = run(["HEAD"]);
    }
    return raw.split("\n").map((l) => l.trim()).filter(Boolean);
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("Invalid base ref")) throw e;
    throw new Error("Failed to get changed files", { cause: e });
  }
}

/**
 * Find the git repository root for a given directory.
 * Throws if not inside a git repo.
 */
export function getGitRoot(cwd: string): string {
  try {
    return execFileSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      timeout: 5000,
    }).trim();
  } catch (e) {
    throw new Error(`Not a git repository: ${cwd}`, { cause: e });
  }
}

/**
 * Get a unified diff of uncommitted changes (staged + unstaged).
 */
export function getUncommittedDiff(cwd: string, contextLines = 5): string {
  try {
    // Staged changes
    const staged = execFileSync(
      "git",
      ["-C", cwd, "diff", "--cached", `-U${contextLines}`],
      { encoding: "utf8", timeout: 30000 },
    ).trim();

    // Unstaged changes
    const unstaged = execFileSync(
      "git",
      ["-C", cwd, "diff", `-U${contextLines}`],
      { encoding: "utf8", timeout: 30000 },
    ).trim();

    const parts = [staged, unstaged].filter(Boolean);
    if (parts.length === 0) {
      throw new Error("No uncommitted changes found");
    }
    return parts.join("\n");
  } catch (e) {
    if (e instanceof Error && e.message === "No uncommitted changes found") {
      throw e;
    }
    throw new Error("Failed to get git diff", { cause: e });
  }
}

/**
 * Get a diff between the current branch and a base branch/ref.
 */
export function getBranchDiff(cwd: string, base: string, contextLines = 5): string {
  try {
    const diff = execFileSync(
      "git",
      ["-C", cwd, "diff", `${base}...HEAD`, `-U${contextLines}`],
      { encoding: "utf8", timeout: 30000 },
    ).trim();

    if (!diff) {
      throw new Error(`No diff found between ${base} and HEAD`);
    }
    return diff;
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("No diff found")) {
      throw e;
    }
    throw new Error(`Failed to get branch diff against "${base}"`, { cause: e });
  }
}
