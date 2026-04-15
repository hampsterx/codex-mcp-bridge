import path from "node:path";
import {
  getGitRoot,
  getDiffStat,
  getDiffFiles,
  type DiffStat,
  type DiffSpec,
} from "../utils/git.js";
import { verifyDirectory } from "../utils/security.js";

export type Complexity = "trivial" | "moderate" | "complex";

export interface AssessSuggestion {
  depth: "scan" | "focused" | "deep";
  estimatedSeconds: number;
  description: string;
}

export interface AssessInput {
  uncommitted?: boolean;
  base?: string;
  workingDirectory?: string;
}

export interface AssessResult {
  diffStat: DiffStat;
  changedFiles: string[];
  complexity: Complexity;
  suggestions: AssessSuggestion[];
  resolvedCwd: string;
}

/**
 * Package manifests and lockfiles that disproportionately affect the
 * build or dependency graph. Matched against `path.basename()` so
 * monorepos with nested packages (e.g. `packages/api/package.json`)
 * also get flagged, not just repo-root files.
 */
const PACKAGE_MANIFEST_PATTERNS: RegExp[] = [
  /^package\.json$/,
  /^package-lock\.json$/,
  /^pnpm-lock\.yaml$/,
  /\.lock$/,
  /^go\.mod$/,
  /^tsconfig\.json$/,
  /^Cargo\.toml$/,
  /^pyproject\.toml$/,
  /^requirements.*\.txt$/,
];

function isPackageManifest(filePath: string): boolean {
  const base = path.basename(filePath);
  return PACKAGE_MANIFEST_PATTERNS.some((re) => re.test(base));
}

function topLevelBucket(filePath: string): string {
  const dir = path.dirname(filePath);
  if (dir === "" || dir === ".") return ".";
  return dir.split("/")[0] || ".";
}

/**
 * Classify diff complexity from stat and file paths.
 *
 * - trivial: ≤3 files AND ≤50 total lines AND 0 package manifests
 * - complex: >10 files OR >300 lines OR ≥3 distinct top-level dirs
 *   OR ≥1 package manifest / lockfile (anywhere in the repo)
 * - moderate: otherwise
 *
 * Root-level files count as a single bucket (".") for the top-level
 * dir heuristic, matching `path.dirname()` behaviour.
 */
export function classifyComplexity(stat: DiffStat, files: string[]): Complexity {
  const totalLines = stat.insertions + stat.deletions;
  const topLevelDirs = new Set(files.map(topLevelBucket));
  const manifestCount = files.filter(isPackageManifest).length;

  if (
    stat.files > 10 ||
    totalLines > 300 ||
    topLevelDirs.size >= 3 ||
    manifestCount >= 1
  ) {
    return "complex";
  }
  if (stat.files <= 3 && totalLines <= 50 && manifestCount === 0) {
    return "trivial";
  }
  return "moderate";
}

/**
 * Build review depth suggestions with estimated wall-clock durations.
 *
 * Estimates are approximate expected times, not timeout budgets. Codex
 * CLI spawn is lightweight; wall time is dominated by inference + MCP
 * startup, so per-file coefficients are conservative starting points.
 */
export function buildSuggestions(stat: DiffStat): AssessSuggestion[] {
  return [
    {
      depth: "scan",
      estimatedSeconds: 30,
      description: "Diff-only, no repo exploration. Fast single-pass review.",
    },
    {
      depth: "focused",
      estimatedSeconds: Math.min(30 + 10 * stat.files, 240),
      description:
        "Reads changed files for context. Does not trace imports or check tests.",
    },
    {
      depth: "deep",
      estimatedSeconds: Math.min(60 + 25 * stat.files, 1200),
      description:
        "Full repo exploration: follows imports, checks tests, reads project conventions.",
    },
  ];
}

/**
 * Assess a diff and return structured analysis with review depth suggestions.
 *
 * Pure Node operation, no CLI spawn, no model call. Runs git locally to
 * classify the diff and suggest appropriate review depth levels.
 */
export async function executeAssess(input: AssessInput): Promise<AssessResult> {
  const { uncommitted = true, base } = input;

  if (!base && !uncommitted) {
    throw new Error(
      "Either 'uncommitted' must be true or 'base' must be specified",
    );
  }

  const requestedDir = input.workingDirectory
    ? await verifyDirectory(input.workingDirectory)
    : process.cwd();
  const cwd = getGitRoot(requestedDir);

  const diffSpec: DiffSpec = base
    ? { type: "branch", base }
    : { type: "uncommitted" };

  const diffStat = getDiffStat(cwd, diffSpec) ?? {
    files: 0,
    insertions: 0,
    deletions: 0,
  };
  const changedFiles = getDiffFiles(cwd, diffSpec);
  const complexity = classifyComplexity(diffStat, changedFiles);
  const suggestions = buildSuggestions(diffStat);

  return {
    diffStat,
    changedFiles,
    complexity,
    suggestions,
    resolvedCwd: cwd,
  };
}
