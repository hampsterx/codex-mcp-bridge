# CLAUDE.md - codex-mcp-bridge

## Project Overview

Open source MCP server that wraps Codex CLI as a subprocess, exposing code execution, agentic review, web search, and structured output as MCP tools. Works with any MCP-compatible client: Claude Code, Gemini CLI, Cursor, Windsurf, VS Code.

- **npm package**: `codex-mcp-bridge`
- **License**: MIT
- **Language**: TypeScript
- **Framework**: `@modelcontextprotocol/sdk`

## Architecture

```
MCP Client  --stdio-->  codex-mcp-bridge  --spawn-->  codex CLI subprocess
```

Prompts are assembled in TypeScript and spawned via the CLI. The `review`, `search`, and `query` tools load prompt templates from `prompts/*.md` via `src/utils/prompts.ts` and fill placeholders. The `review` tool's agentic mode runs Codex in `--full-auto` inside the target repo, letting it explore files, follow imports, and read project instruction files.

## Tools

| Tool | Purpose | Default Timeout |
|------|---------|----------------|
| `codex` | Execute prompts with file context, session resume, sandbox control | 60s |
| `review` | Agentic repo-aware code review (Codex explores repo in full-auto) | 300s (agentic) / 120s (quick) |
| `search` | Web search via `codex --search` | 120s |
| `query` | Lightweight text analysis (no repo context, no sessions) | 60s |
| `structured` | JSON Schema validated output (Ajv) | 60s |
| `ping` | Health check + CLI capability detection | 10s |
| `listSessions` | List active Codex conversation sessions | 30s |

### Codex Tool Details

Supports session resume via `sessionId`. Pass `resetSession: true` to discard an existing session and start fresh. Use `listSessions` to inspect active sessions before resuming.

### Review Tool Details

Two modes:

- **Agentic (default)**: Codex CLI runs in `--full-auto` mode inside the repo. It runs `git diff`, reads full files, follows imports, checks tests, and reads project instruction files before reviewing.
- **Quick** (`quick: true`): Sends only the diff text. Single-pass, no repo exploration.

Optional `focus` parameter directs attention (e.g. "security", "performance", "error handling").

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
npm run smoke -- review ~/NUI/cream    # review tool against another repo
npm run smoke -- search                # web search
npm run smoke -- query                 # lightweight query
npm run smoke -- ping                  # health check
```

## Key Design Decisions

### Progress Heartbeats
Codex, review, and search handlers emit MCP `notifications/progress` every 15s
during subprocess execution when the client provides a `progressToken` in `_meta`.
Fire-and-forget (silent on unsupported clients). Implemented in `src/utils/progress.ts`.

### Subprocess Environment (Security Critical)
- **Explicit env allowlist**, never spread `process.env`
- Allowed keys: `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OPENAI_ORG_ID`, `CODEX_HOME`, `CODEX_DEFAULT_MODEL`, `HOME`, `PATH`, `USER`, `SHELL`, `LANG`, `TERM`, `XDG_CONFIG_HOME`
- Always set: `NO_COLOR=1`, `FORCE_COLOR=0`

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

Per-tool defaults: `review` agentic mode defaults to `serena` (symbol nav
during review). Pass the `mcpServers` tool param to override; explicit param
wins over env var wins over tool default.

The `required` flag (codex PR #10902) is read straight from `config.toml`
and cannot be disabled by any caller. Parsed synchronously, no per-spawn
subprocess cost. The grammar narrowed in this release: old builds accepted
any non-empty non-`inherit` value as raw TOML; now only values starting with
`{` or `[` do. Unreleased env var, non-breaking.

## Testing

- `tests/tools/` - Tool-level tests (mock subprocess)
- `tests/utils/` - Utility unit tests
- `tests/integration/` - End-to-end with real Codex CLI (gated by `CODEX_INTEGRATION=1`)

## CI/CD

- **ci.yml**: lint + typecheck + test + build on PRs (Node 18/20/22)
- **publish.yml**: validate on `v*` tag push (no auto-publish, npm 2FA requires OTP)

### Release Workflow

See [RELEASING.md](RELEASING.md) for the full checklist including pre-release checks, publish steps, and post-release npm validation.

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
