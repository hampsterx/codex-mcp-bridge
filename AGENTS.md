# AGENTS.md - codex-mcp-bridge

Guidance for AI coding agents working in the codex-mcp-bridge repository.

This file defines repository-specific operating rules for autonomous or semi-autonomous coding agents. Follow these instructions unless a maintainer explicitly tells you otherwise.

## Project Overview

Open source MCP server that wraps Codex CLI as a subprocess, exposing code execution, web search, and structured output as MCP tools. Works with any MCP-compatible client: Claude Code, Gemini CLI, Cursor, Windsurf, VS Code.

- **npm package**: `codex-mcp-bridge`
- **License**: MIT
- **Language**: TypeScript
- **Framework**: `@modelcontextprotocol/sdk`

## Architecture

```
MCP Client  --stdio-->  codex-mcp-bridge  --spawn-->  codex CLI subprocess
```

Prompts are assembled in TypeScript and spawned via the CLI. The `search` and `query` tools load prompt templates from `prompts/*.md` via `src/utils/prompts.ts` and fill placeholders. The `codex` tool is fully caller-driven: callers pass any prompt and pick the sandbox level. For code review, callers either invoke `codex review` directly or pass a review prompt to the `codex` tool with `sandbox: "read-only"` (see [README § Code review with this CLI](README.md#code-review-with-this-cli) and [ADR-001](docs/decisions/001-remove-review-and-assess-tools.md)).

## Tools

| Tool | Purpose | Default Timeout |
|------|---------|----------------|
| `codex` | Execute prompts with file context, session resume, sandbox control | 60s |
| `search` | Web search via `codex --search` | 120s |
| `query` | Lightweight text analysis (no repo context, no sessions) | 60s |
| `structured` | JSON Schema validated output (Ajv) | 60s |
| `ping` | Health check + CLI capability detection | 10s |
| `mcpStatus` | Per-server MCP boot state via `codex app-server` | 90s/request |
| `listSessions` | List active Codex conversation sessions | 30s |

### Picking a tool: match the invocation to the task shape

The three tools differ in startup cost, not just capability, and the expensive one
is easy to reach for by default.

- **"Review this diff or branch"** → `review`. It runs the git diff and explores the
  repo itself, which is what it is built for.
- **"Execute, build or fix something in a repo"** → `codex` with `workingDirectory`.
  Agentic coding is what the subprocess cost buys.
- **"Read this and give me your opinion"** (a plan, a design, an argument) → `query`,
  or inline the relevant snippets in the prompt. Do **not** reach for `codex` with
  `files` here. Spawning the agentic path pays for sandbox setup, AGENTS.md/CODEX.md
  reading and env init before any reasoning starts, and that overhead buys nothing
  when no repo exploration is needed: a plan review with three files inlined at
  `reasoningEffort: high` spent its whole 60s budget on startup and timed out.
  Judgment calls want `reasoningEffort: medium`; if the agentic path is genuinely
  required for an opinion task, raise the timeout to 180-240s and keep input minimal.

**The 3-concurrent cap is a caller's problem, not just a config value.** A workflow
that fans a verify or review stage out over N items will exceed it whenever N > 3,
because the harness concurrency cap is far higher. The 4th call waits 30s and then
returns `Concurrency queue timeout after 30000ms - 3 processes active`, and its
prompt never reaches Codex at all. That is queue contention, and it is easy to
misread downstream as a real Codex failure or a missing capability. Chunk the fanned
stage into groups of 3, or expect some results to come back unavailable and re-run
those single passes afterwards. Separately, one high-reasoning call with web search
can hit the 10-minute cap; drop to `reasoningEffort: medium` and tighten the prompt.

### Codex Tool Details

Supports session resume via `sessionId`. Pass `resetSession: true` to discard an existing session and start fresh. Use `listSessions` to inspect active sessions before resuming.

### Query Tool Details

Lightweight, non-agentic query for text analysis. Spawns in an isolated temp directory (not the bridge's repo) with `--sandbox read-only --skip-git-repo-check --ephemeral`. No file reading, no session state, all non-required MCP servers disabled. Supports `reasoningEffort` and `maxResponseLength`.

### Structured Tool Details

Embeds a JSON Schema in the prompt and validates the response with Ajv. Returns the raw JSON on success, validation errors on failure. Max schema size: 20KB.

## Development

```bash
npm install          # Install dependencies
npm run build        # Compile TypeScript
npm run dev          # Watch mode
npm test             # Run tests (80 unit tests)
npm run lint         # ESLint
npm run typecheck    # tsc --noEmit
```

### Testing changes without restarting MCP client

MCP servers are long-lived processes. After rebuilding, use the smoke test to call compiled tool functions directly, bypassing the running server:

```bash
npm run smoke                          # codex tool, cwd
npm run smoke -- codex /path/to/repo   # codex with specific workingDirectory
npm run smoke -- search                # web search
npm run smoke -- query                 # lightweight query
npm run smoke -- ping                  # health check
```

## Key Design Decisions

### Progress Heartbeats
Codex, search, and query handlers emit MCP `notifications/progress` every 15s
during subprocess execution when the client provides a `progressToken` in `_meta`.
Fire-and-forget (silent on unsupported clients). Implemented in `src/utils/progress.ts`.

### Subprocess Environment (Security Critical)
- **Explicit env allowlist**, never spread `process.env`
- Allowed keys: `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OPENAI_ORG_ID`, `CODEX_HOME`, `CODEX_DEFAULT_MODEL`, `HOME`, `PATH`, `USER`, `SHELL`, `LANG`, `TERM`, `XDG_CONFIG_HOME`
- Always set: `NO_COLOR=1`, `FORCE_COLOR=0`
- **One deliberate exception**: `buildIntrospectionEnv()` (used only by `mcpStatus`) inherits the full environment. MCP servers read their credentials from it (`bearer_token_env_var`, `mcp_servers.NAME.env`), so under the allowlist they fail to start and the tool reports fabricated failures for healthy servers. Acceptable there because that path submits no turn, so no value reaches a model, and the only text it returns is the redacted startup error. Do not reuse it for any tool that talks to a model.

### MCP Boot Introspection (`mcpStatus`)
- Drives `codex app-server`, an **experimental** JSONL protocol. Shapes are version-bound; `tests/utils/appserver-schema-drift.test.ts` regenerates the schema from the installed CLI and diffs it against `tests/fixtures/appserver-mcp-schema.json`.
- Cannot reuse `spawnCodex`: that closes stdin and buffers stdout to a string. `src/utils/app-server.ts` is a separate streaming transport holding one concurrency slot.
- **`serverInfo` is not a health bit.** Slow list calls have been observed reporting explicitly-`ready` servers as uninitialized, so absence means `unknown` and `failed` comes only from a startup notification.
- MCP servers boot in **two rounds** per thread, emitting four notifications each; `cancelled` belongs to the superseded first attempt and arrives *before* `ready`. The merge discards `starting` and `cancelled` outright.
- Full rationale, and the premise that would void the environment exception: `docs/decisions/002-mcp-introspection-reports-observation-not-health.md`.

### Subprocess Spawning
- Always `spawn` with `shell: false`, args as array (never `exec`)
- Pipe large prompts via stdin (avoids `ARG_MAX` limit)
- Kill process group on timeout: SIGTERM -> 5s grace -> SIGKILL
- Max 3 concurrent spawns (configurable via `CODEX_MAX_CONCURRENT`), queue excess (FIFO, 30s queue timeout)

### Output Parsing
- JSONL event parsing (stdout primary, stderr fallback)
- Falls back to JSON parsing, then plain text
- Tolerates malformed JSON, extracts response text from partial output
- Redacts potential secrets (API keys, Bearer tokens) from CLI output

### Path Security
- All paths resolved via `realpath`
- Verify within allowed root directory (no traversal)
- No symlink following outside root
- Max file size: 1MB text, 5MB image, 20 files max

### Model Fallback
- On quota exhaustion, auto-retries with fallback model (default: `o3`)
- Configurable via `CODEX_FALLBACK_MODEL`, set to `none` to disable

## Configuration

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| `CODEX_DEFAULT_MODEL` | _(CLI default)_ | Default model for all tools |
| `CODEX_FALLBACK_MODEL` | `o3` | Fallback on quota exhaustion. `none` to disable |
| `CODEX_CLI_PATH` | `codex` | Path to Codex CLI binary |
| `CODEX_MAX_CONCURRENT` | `3` | Max concurrent subprocess spawns |
| `CODEX_MCP_SERVERS` | _(unset)_ | MCP server enable grammar. See below. |

### `CODEX_MCP_SERVERS` grammar

Controls which MCP servers from `~/.codex/config.toml` stay enabled inside
the Codex subprocess. Branches evaluated top-to-bottom:

1. **unset / empty / whitespace** → disable every configured server except
   those marked `required = true` in config.toml.
2. **`inherit`** (exact, case-sensitive) → pass through config unchanged.
3. **first non-ws char is `{` or `[`** → raw TOML escape hatch, forwarded as
   `-c mcp_servers=<value>`.
4. **otherwise** → comma-separated list of server names to enable. Every
   other configured server gets disabled (except required ones). Unknowns
   warn to stderr once and are dropped.

Per-tool defaults: all tools currently use disable-all. The `codex` tool
inherits from the `CODEX_MCP_SERVERS` env var; explicit caller params win
over env var wins over tool default.

The `required` flag (codex PR #10902) is read straight from `config.toml`
and cannot be disabled by any caller. Parsed synchronously, no per-spawn
subprocess cost. The grammar narrowed in this release: old builds accepted
any non-empty non-`inherit` value as raw TOML; now only values starting with
`{` or `[` do. Unreleased env var, non-breaking.

This grammar is codex-only and part of the bridge's value proposition over
bare Codex CLI. Do not break it during refactors (see Release Footguns below).

## Testing

- `tests/tools/` - Tool-level tests (mock subprocess)
- `tests/utils/` - Utility unit tests
- `tests/integration/` - End-to-end with real Codex CLI (gated by `CODEX_INTEGRATION=1`)

## CI/CD

- **ci.yml**: lint + typecheck + test + build on PRs (Node 18/20/22)
- **publish.yml**: OIDC trusted publishing on `v*` tag push (lint + test + build + publish with provenance)

### Release Workflow

The maintainer's `RELEASING.md` is gitignored (personal checklist); the release-critical pitfalls are inlined in the next section so contributors see them on clone.

## Release Footguns

Pitfalls hit often enough to call out here.

- **`mcpName` in `package.json` must match `server.json.name`.** The MCP Registry verifies ownership by reading `mcpName` from the published tarball and cross-checking `server.json`. Mismatch = registry rejects publish. Current value: `io.github.hampsterx/codex-mcp-bridge`.
- **`server.json` version must match `package.json` and the npm tarball.** `npm version X.Y.Z` updates `package.json` + `package-lock.json` but does **not** touch `server.json`. Bump top-level `version` and `packages[0].version` by hand. Registry rejects any mismatch.
- **`server.json` env var defaults must be strings.** Even when the field declares `format: "number"` or `format: "boolean"`, the registry schema requires the `default` to be a JSON string (`"3"`, `"true"`). The declared `format` is advisory; the serialized default is still validated as a string. Convergent reviewer suggestions to "fix the type mismatch" by changing `"3"` → `3` will pass local schema linters and then fail at publish time.
- **OIDC publish requires npm ≥ 11.5.1.** Node 20 in GitHub Actions ships npm 10, which does not support OIDC trusted publishing. `publish.yml` works around this with `npx --yes npm@latest publish --provenance --access public`. Do not revert to bare `npm publish`.
- **Model fallback on quota exhaustion is a feature, not a bug.** Default fallback is `o3` (v0.2.3+). Removing or disabling without a deprecation plan breaks silent recovery that downstream users rely on. `CODEX_FALLBACK_MODEL=none` is the opt-out.
- **Session resume / `forked_from_id`.** Codex CLI has native `forked_from_id` support the bridge deliberately does not expose. Do not naively wire up `--resume` pass-through; the interactions with `sessionId` in the `codex` tool are subtle and there are open design notes in maintainer-local working docs. Ask before changing session behaviour.
- **Windows path handling.** `src/utils/windows.ts` exists for a reason. Any new CLI spawn that builds args must go through the shared path normaliser; shell escaping on Windows is not the same as POSIX.
- **`CODEX_MCP_SERVERS` grammar is codex-only.** Refactors that "simplify" the env var handling have a habit of collapsing the four branches into one broken case. Run the dedicated test suite before changing parsing.
- **Upstream contributions are invitation-only.** `openai/codex` does not accept unsolicited PRs ([upstream policy](https://github.com/openai/codex/blob/main/docs/contributing.md)). File an issue first, wait for maintainer response, and only then open a PR.

## Git Workflow

- Use feature branches with PRs for all changes (do not commit directly to master)
- Branch naming: `feat/`, `fix/`, `refactor/` prefix, kebab-case
- Squash merge PRs

## Conventions

- Prefer explicit over clever
- No default exports
- Error messages must be actionable ("codex CLI not found - install with: npm i -g @openai/codex")
- All public functions must have JSDoc
- Tests colocated by directory: `tests/tools/`, `tests/utils/`
