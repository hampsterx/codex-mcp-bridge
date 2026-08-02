# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/).

## [0.9.1] - 2026-08-02

### Fixed

- **The requested sandbox level is now binding, not advisory.** `0.9.0` made
  every path emit a `--sandbox` level; this makes the level hold. Codex's
  `approvals_reviewer` config key decides who approves a sandbox *escalation*,
  and its non-default `auto_review` value hands that decision to a model rather
  than a human. Under `codex exec` there is no human in the loop, so a user
  config carrying `auto_review` let the subprocess escalate straight out of the
  level in its own argv, silently. Measured on `codex-cli 0.145.0`, a turn
  carrying `--sandbox read-only` wrote files through both Codex's native edit
  tool and a plain `echo > file` shell command, on fresh and resumed turns
  alike, in trusted and untrusted directories. Every path that declares a level
  now also emits `-c approvals_reviewer="user"`, which restores the refusal.
  Applies to `codex`, `query`, `search` and `structured`, and rides along with
  `--full-auto` as well: that caller asked for `workspace-write`, not for an
  unsupervised route past it. The setting also has a second route in, a
  project-local `.codex/config.toml` in a trusted directory, so a repository can
  carry the escalating value in-tree; the runtime `-c` override outranks both
  layers. `review` passes `--ignore-user-config` and is not exposed by either.
- **`search` declares a sandbox level.** It emitted none at all, so its sandbox
  came from user config and project trust, and a trusted working directory
  silently gave a web-search synthesis `workspace-write`. It now declares
  `read-only`.

## [0.9.0] - 2026-08-02

### Fixed

- **Resumed turns no longer inherit their sandbox from user config.**
  `codex exec resume` takes its sandbox from user config and project trust when
  no sandbox flag is given, which resolves to `workspace-write` inside any
  trusted directory. The resume path emitted no such flag, so a caller
  requesting `sandbox: "read-only"` got read-only on the first turn and
  workspace-write on every turn resumed via `sessionId`. Every path now emits a
  sandbox flag, placed before the `resume` subcommand, and an unspecified
  sandbox resolves to `read-only` in the argument builder rather than only in
  the MCP input schema. The level is per request, not sticky: a turn that wants
  anything above `read-only` states it, and omitting it de-escalates rather
  than inheriting.
- **Prompts are no longer parsed as Codex options.** `codex exec` reads its
  trailing prompt positional as options, so a prompt of `--version` printed the
  CLI version instead of reaching the model, and a prompt following image paths
  was consumed as another `-i` value (`--image` is variadic). The `codex` and
  `structured` tools now pass `--` before the prompt, on both the new and the
  resume paths. See `SECURITY.md` § Argument Injection for the mechanism,
  including why this stopped short of code execution and what would have
  removed that margin.
- **Caller values bind to their flags.** Unconstrained caller strings passed in
  the `--flag value` form are rejected outright by Codex when the value starts
  with a dash (`a value is required for '--title <TITLE>'`), failing the whole
  invocation. `--model` now uses the `--flag=value` form in all five tools
  (`codex`, `review`, `search`, `query`, `structured`), so the argv every tool
  emits changes; `review`'s `base`, `commit`, and `title` use it too.
- **`isValidSessionId` rejects a leading dash.** The conversation ID is the one
  positional ahead of the `--` separator, so a dash-prefixed value would present
  to Codex as a flag. The ID comes from CLI output rather than the caller, so
  this is low risk, but it is a behaviour change in an exported helper.

## [0.8.0] - 2026-07-09

### Added

- **Token usage in `_meta`**: `codex` and `query` responses now carry
  `_meta.usage` with per-turn token counts
  (`inputTokens`, `cachedInputTokens`, `outputTokens`, `reasoningTokens`)
  read from the Codex exec `turn.completed` event. Orchestrating agents get
  token accounting for free. The field is absent (not zeroed) when the stream
  emits no usage. Dollar cost is still not reported: Codex exec emits token
  counts but not cost.
- **Release-coherence CI guard**: `scripts/check-changelog.mjs` fails when the
  release is not coherent: `package.json`'s `version` has no matching
  `## [x.y.z]` heading in `CHANGELOG.md`, or `server.json` / `package-lock.json`
  disagree with that version (a stale `server.json` breaks the MCP Registry
  publish). Wired into CI (runs on every PR) and `prepublishOnly` so neither a
  missing changelog section nor a version-file drift can ship.

### Fixed

- **Model fallback now catches rate limits reported on stdout.** When Codex
  reports a rate-limited turn as a stdout JSONL `turn.failed` (or terminal
  `error`) event with exit 0 and clean stderr, `withModelFallback` now retries
  with the configured fallback model instead of surfacing an MCP error. Only the
  rate-limit/quota subset retries; other fatals (context length, tool crash)
  still surface. Covers `codex`, `query`, `search`, `structured`, and `review`.

## [0.7.0] - 2026-04-28

### Added

- **`review` tool**: native diff-aware code review via
  `codex exec review --json`. The bridge owns no reviewer prompt; upstream
  Codex supplies the review instructions. Three diff selectors: `uncommitted`
  (working-tree changes), `base` (diff against a base branch/ref), and
  `commit` (a single commit). For MCP clients that cannot shell out but need
  native Codex review. `_meta` reports the review `mode`, per-type
  `eventCounts`, `parseFailures`, executed `commands`, and `threadId`.
  See PR #30.

## [0.6.0] - 2026-04-26

### Removed

- **`review` tool**: bundled reviewer prompts and depth selector retired. Use
  the native `codex review --base <branch>` for diff-aware review, or call the
  `codex` tool with `sandbox: "read-only"` and a caller-supplied review prompt.
  See [README § Code review with this CLI](README.md#code-review-with-this-cli)
  and [ADR-001](docs/decisions/001-remove-review-and-assess-tools.md).
- **`assess` tool**: removed alongside `review`. Its only consumer was the
  `review` depth grammar; without `review` the recommendations have no anchor.
- **Bundled reviewer prompts**: `prompts/review-agentic.md`,
  `prompts/review-agentic-with-serena.md`, `prompts/review-focused.md`,
  `prompts/review-quick.md`.
- **Review-only env vars**: `CODEX_REVIEW_SCAN_TIMEOUT_MS`,
  `CODEX_REVIEW_FOCUSED_BASE_MS`, `CODEX_REVIEW_FOCUSED_PER_FILE_MS`,
  `CODEX_REVIEW_FOCUSED_CAP_MS`, `CODEX_REVIEW_FOCUSED_FALLBACK_MS`,
  `CODEX_REVIEW_DEEP_BASE_MS`, `CODEX_REVIEW_DEEP_PER_FILE_MS`,
  `CODEX_REVIEW_DEEP_FALLBACK_MS`. No replacement; callers manage timeouts
  via the existing per-call `timeout` parameter on the `codex` tool.

### Changed

- **Tool surface**: `codex`, `query`, `search`, `structured`, `ping`,
  `listSessions` (was: those plus `review` and `assess`).

## [0.5.1] - 2026-04-21

### Added

- **MCP Registry manifest**: `server.json` describing the server for
 [registry.modelcontextprotocol.io](https://registry.modelcontextprotocol.io).
 Added `mcpName: io.github.hampsterx/codex-mcp-bridge` to `package.json` so
 the registry can verify npm ownership against the published tarball.
 No runtime behaviour change.

## [0.5.0] - 2026-04-15

### Added

- **`assess` tool**: pure-local diff assessment that classifies a git diff as
 trivial / moderate / complex and suggests a review depth (`scan`, `focused`,
 `deep`) with estimated wall-clock times. No CLI spawn, no model call, no
 cost. Use before `review` to match review time to change size. Package
 manifests and lockfiles (package.json, package-lock.json, pnpm-lock.yaml,
 yarn.lock / composer.lock / other `*.lock`, tsconfig, go.mod, Cargo.toml,
 pyproject.toml, requirements*.txt) anywhere in the repo, not just at the
 root, promote the classification to `complex`.
- **`getDiffFiles` git util**: returns the list of changed paths for a diff
 spec via `git diff --name-only`. Shares base-ref validation with `review`
 via a centralised `validateBaseRef` helper in `utils/git.ts`; both tools
 accept alphanumeric, `-`, `_`, `/`, `.`, `~`, `^` (so ancestry refs like
 `HEAD~1` / `main^` work in either tool).
- **Review depth tiers**: new `depth` parameter with three values:
  - `scan`: diff-only, single-pass (matches the old `quick: true` behaviour).
  - `focused`: pre-inlines the diff and instructs Codex to read only the
    changed files. Spawns with `--sandbox read-only --skip-git-repo-check
    --ephemeral` (same containment stack as `query`). Containment past
    no-writes is prompt-driven, Codex can still shell.
  - `deep` (default): full agentic `--full-auto` exploration. Matches the
    previous default behaviour.

  Large diffs (>1000 insertions+deletions) in focused mode attach a warning
  suggesting `depth: "deep"` due to context-window pressure.
- **Per-depth timeout env vars**: `CODEX_REVIEW_SCAN_TIMEOUT_MS`,
 `CODEX_REVIEW_FOCUSED_{BASE,PER_FILE,CAP,FALLBACK}_MS`,
 `CODEX_REVIEW_DEEP_{BASE,PER_FILE,FALLBACK}_MS`. Operators can tune
 timeouts without a release. Defaults preserve prior behaviour for scan
 (120s) and deep (180s + 30s/file); focused is new (120s + 15s/file, cap
 300s). Deep fallback when diff stat is unavailable increased from 300s
 to 600s.
- **Per-depth MCP server defaults**: deep → `serena` (symbol nav), focused
 and scan → `""` (disable all non-required). Explicit `mcpServers` tool
 param and `CODEX_MCP_SERVERS` env var still override the default.

### Changed

- **BREAKING: `ReviewResult.mode` values changed** from `"agentic" | "quick"`
 to `"scan" | "focused" | "deep"`. Programmatic consumers must update
 assertions. The human-readable `Mode:` line in the tool output now emits
 the new values. Pre-1.0 allows this clean break; no legacy-alias transition.
- **Deprecation: `quick` parameter**. Still accepted: `quick: true` → scan,
 `quick: false` → deep. When both `quick` and `depth` are set, `depth`
 wins and a one-line warning is logged to stderr. Will be removed after
 one minor cycle.

## [0.4.0] - 2026-04-13

### Added

- **Expanded reasoningEffort enum**: 6 levels (`none`, `minimal`, `low`, `medium`,
  `high`, `xhigh`) replacing the previous 3-level enum
- **Supported models in ping**: `ping` response now includes the list of models
  available in the Codex CLI
- **Review timeout auto-scaling**: agentic review timeout scales from diff size
  (line count and file count) instead of using a fixed ceiling

### Fixed

- **releaseSlot underflow guard**: `activeCount` can no longer go negative if
  `releaseSlot` is called more times than `acquireSlot`

### Changed

- Test coverage expanded: missing test suites added, coverage gaps filled
  (378 tests across 24 suites)

## [0.3.0] - 2026-04-13

### Added

- **Line range specifiers**: file paths now support `path:start-end` syntax
  (1-based, inclusive) to include only relevant sections, reducing wasted context
- Timeout scaling for multi-file calls bumped from 60s+15s/file to 180s+30s/file

### Fixed

- Non-zero CLI exits now surface as errors when no response is produced
- Unsafe error message casts replaced with `toErrorMessage` helper throughout
- `ping` tool now reports non-ENOENT failures correctly
- Stale `sessionId` no longer returned after `resetSession`
- Prompt placeholder collision fixed via single-pass regex replacement
- Schema size check uses `Buffer.byteLength` instead of `.length`
- `readFiles` uses per-file try/catch for resilience (one bad path no longer
  fails the entire batch)
- `review` validates base refs in both agentic and quick modes
- Session `get()` returns shallow copies to prevent external mutation

### Changed

- README split into three focused docs: README.md (user-facing), DESIGN.md
  (architecture), SECURITY.md (hardening details)
- Error constants consolidated to single sources (HARD_TIMEOUT_CAP in spawn.ts)
- MCP server override logic extracted into named helpers

## [0.2.2] - 2026-04-12

### Changed

- CI publish workflow switched to OIDC trusted publishing with provenance

## [0.2.1] - 2026-04-12

### Fixed

- Concurrency queue leak: `acquireSlot` did not remove its own entry from the
  wait queue on timeout because `findIndex` compared the stored wrapper against
  the outer promise's raw `resolve`. Stale entries then got picked by
  `releaseSlot`, which bumped `activeCount` by one per stale entry and
  permanently pinned the pool at `CODEX_MAX_CONCURRENT` with zero live
  subprocesses. Entries are now captured by reference and removed via
  `indexOf`.

### Added

- `query` tool: lightweight, non-agentic text analysis. Spawns in an isolated
  temp directory with `--sandbox read-only --skip-git-repo-check --ephemeral`.
  No file reading, no session state, all non-required MCP servers disabled.
  Supports `reasoningEffort` and `maxResponseLength`.
- Progress heartbeats: `codex`, `review`, and `search` tools emit MCP
  `notifications/progress` every 15s during subprocess execution when the
  client provides a `progressToken` in `_meta`. Fire-and-forget (silent on
  unsupported clients).
- `ping` output now includes `activeCount` and `queueDepth` for faster
  diagnosis of queue state from a live bridge.
- MCP server controls: per-server enable grammar via `CODEX_MCP_SERVERS` env
  var. Modes: unset (disable all non-required), `inherit` (pass through),
  `{`/`[` prefix (raw TOML), or comma-separated server names. `review` agentic
  mode defaults to enabling `serena`.
- `codex` tool description now includes tool selection guidance to help LLMs
  pick the right tool. Review timeout auto-scales with `git diff --numstat`
  file count.

## [0.2.0] - 2026-04-08

### Added

- `listSessions` tool for inspecting active Codex conversation sessions
- `resetSession` parameter on `codex` tool to discard and restart sessions
- MCP tool annotations (readOnlyHint, openWorldHint, etc.) on all tools
- `_meta` execution metadata (model, duration, timeout, sessionId) in all tool responses
- Rich markdown tool descriptions with usage examples and parameter docs
- Smoke test script (`npm run smoke`) for quick post-build validation
- CLAUDE.md project instructions

### Changed

- CI publish step removed in favour of manual `npm publish` with OTP

## [0.1.0] - 2026-04-05

### Added

- Initial release
- `codex` tool: execute prompts with file context, session resume, sandbox control
- `review` tool: agentic (full-auto) and quick (diff-only) code review
- `search` tool: web search via Codex CLI `--search` flag
- `structured` tool: JSON Schema validated output with Ajv
- `ping` tool: health check and CLI capability detection
- Hardened subprocess environment with explicit env allowlist
- Path sandboxing with realpath boundary checks
- Log redaction for potential secrets in CLI output
- Concurrency limiting (max 3, FIFO queue)
- Model fallback on quota exhaustion (default: o3)
- Session management for multi-turn conversations
- Windows argument escaping support
- CI/CD with GitHub Actions (lint, test, build on Node 18/20/22)
- CI validation on tag push (manual npm publish with OTP)
