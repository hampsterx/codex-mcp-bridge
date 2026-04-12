# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

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
