# codex-mcp-bridge

[![npm version](https://img.shields.io/npm/v/codex-mcp-bridge)](https://www.npmjs.com/package/codex-mcp-bridge)
[![npm downloads](https://img.shields.io/npm/dm/codex-mcp-bridge)](https://www.npmjs.com/package/codex-mcp-bridge)
[![CI](https://github.com/hampsterx/codex-mcp-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/hampsterx/codex-mcp-bridge/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/node/v/codex-mcp-bridge)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![MCP](https://img.shields.io/badge/MCP-compatible-8A2BE2)](https://modelcontextprotocol.io/)

MCP server that wraps [Codex CLI](https://github.com/openai/codex) as a subprocess, exposing code execution, agentic review, web search, and structured output as MCP tools.

Works with any MCP-compatible client: Claude Code, Gemini CLI, Cursor, Windsurf, VS Code.

## Do you need this?

If you're in a terminal agent (Claude Code, Codex CLI, Gemini CLI) with shell access, call Codex CLI directly. It's faster, cheaper, and zero overhead:

```bash
# Review current branch vs main
codex review --base main

# Review uncommitted changes
codex review --uncommitted

# Review with custom focus
codex review --base main "Focus on security and error handling"

# From a worktree
codex -C /path/to/worktree review --base main

# General analysis
codex exec "Analyze src/utils/parse.ts for edge cases"
```

**Use this MCP bridge instead when:**
- Your client has no shell access (Cursor, Windsurf, Claude Desktop, VS Code)
- You need structured output with JSON Schema validation (Codex CLI's `--json` has [known bugs](https://github.com/openai/codex/issues/16552))
- You need automatic model fallback on quota exhaustion
- You need concurrency management (max 3 parallel spawns, queuing)

## Quick Start

```bash
npx codex-mcp-bridge
```

Or install globally:

```bash
npm i -g codex-mcp-bridge
```

### Prerequisites

- [Codex CLI](https://github.com/openai/codex) installed (`npm i -g @openai/codex`)
- `OPENAI_API_KEY` environment variable set, or `codex auth login` completed

### Claude Code

```bash
claude mcp add codex-bridge -- npx codex-mcp-bridge
```

### MCP settings.json

```json
{
  "mcpServers": {
    "codex-bridge": {
      "command": "npx",
      "args": ["-y", "codex-mcp-bridge"],
      "env": {
        "OPENAI_API_KEY": "sk-..."
      }
    }
  }
}
```

## Tools

| Tool | Description | Default Timeout |
|------|-------------|-----------------|
| `codex` | Execute prompts with file context, session resume, sandbox control | 60s |
| `review` | Agentic repo-aware code review (Codex explores repo in full-auto) | 300s (agentic) / 120s (quick) |
| `search` | Web search via `codex --search` | 120s |
| `structured` | JSON Schema validated output | 60s |
| `ping` | Health check + CLI capability detection | 10s |
| `listSessions` | List active Codex conversation sessions | 30s |

### codex

General-purpose execution. Supports multi-turn conversations via session IDs, sandbox levels (`read-only`, `workspace-write`, `full-auto`), and reasoning effort control. Pass `resetSession: true` to discard an existing session and start fresh. Use `listSessions` to inspect active sessions before resuming.

### review

Two modes:

- **Agentic (default)**: Codex CLI runs in `--full-auto` mode inside the repo. It runs `git diff`, reads full files, follows imports, checks tests, and reads project instruction files before reviewing.
- **Quick** (`quick: true`): Sends only the diff text. Single-pass, no repo exploration.

> **Note on semantic code navigation**: Codex CLI has no built-in LSP support (tracking upstream [openai/codex#8745](https://github.com/openai/codex/issues/8745)). Agentic review uses `cat`/`grep`/`rg` for repo exploration, which is sufficient for diff-aware review in practice.

### search

Web search powered by Codex CLI's `--search` flag. Returns synthesized answers with source URLs.

### structured

Embeds a JSON Schema in the prompt and validates the response with Ajv. Returns the raw JSON on success, validation errors on failure.

### listSessions

Returns a JSON array of active conversation sessions. Each entry includes `sessionId`, `conversationId`, `model`, `createdAt`, `lastUsedAt`, and `turnCount`. Always returns JSON, even when empty.

### ping

Returns CLI version, available features, model configuration, and concurrency diagnostics (`activeCount`, `queueDepth`). Useful for health monitoring and debugging concurrency issues.

### Execution metadata

All tools attach `_meta` to the `CallToolResult` with execution metadata:

| Field | Type | Present on |
|-------|------|------------|
| `durationMs` | number | All tools |
| `model` | string | Tools that run Codex CLI |
| `fallbackUsed` | boolean | Tools that run Codex CLI |
| `sessionId` | string | `codex` tool only |
| `conversationId` | string | `codex` tool only |

Useful for orchestrating agents that need to track latency, detect quota fallback, or manage session state.

### MCP annotations

All tools declare [MCP annotations](https://modelcontextprotocol.io/specification/2025-03-26/server/tools#annotations) (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`) so MCP clients can make informed permission and safety decisions. The `codex` and `review` tools are marked destructive (full-auto sandbox mode can write files); `search`, `structured`, `listSessions`, and `ping` are read-only.

## Configuration

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| `CODEX_DEFAULT_MODEL` | _(CLI default)_ | Default model for all tools |
| `CODEX_FALLBACK_MODEL` | `o3` | Fallback on quota exhaustion. `none` to disable |
| `CODEX_CLI_PATH` | `codex` | Path to Codex CLI binary |
| `CODEX_MAX_CONCURRENT` | `3` | Max concurrent subprocess spawns |
| `CODEX_MCP_SERVERS` | _(unset)_ | Control Codex's internal MCP servers. See below. |
| `CODEX_HOME` | `~/.codex` | Directory holding Codex's `config.toml`. Honored when enumerating servers. |

### `CODEX_MCP_SERVERS`

When the bridge spawns Codex, any MCP servers in `~/.codex/config.toml`
(`[mcp_servers.*]`) would otherwise load inside Codex and add 30-120s of
startup overhead per call. The bridge already feeds context via prompt + files,
so most nested MCP servers are pure overhead. This env var controls which
servers the bridge keeps enabled:

| Mode | Value | Behavior |
|------|-------|----------|
| **Disable-all** (fastest, default) | unset / empty / whitespace-only | Read `$CODEX_HOME/config.toml` and emit `-c mcp_servers.NAME.enabled=false` for every configured server (except any marked `required = true`, which are always kept enabled). |
| **Selective enable** | comma-separated names, e.g. `serena,ck-search` | Enable exactly the listed servers, disable every other configured server (except required ones). Whitespace trimmed, empty items filtered, duplicates deduped, unknown names warned to stderr and ignored. |
| **Inherit** | `inherit` (exact, case-sensitive) | Pass through whatever's in config unchanged. Use this if you want every configured server available inside the Codex session. |
| **Raw TOML** | value starting with `{` or `[` | Forwarded verbatim as `-c mcp_servers=<value>`. Escape hatch for advanced cases. |

Branches are evaluated top-to-bottom: `CODEX_MCP_SERVERS=inherit` is matched
before the selective-enable branch, and a value beginning with `{` or `[` is
always raw TOML regardless of commas inside.

**Required servers.** Codex PR
[#10902](https://github.com/openai/codex/pull/10902) added a `required = true`
flag under `[mcp_servers.NAME]`. When set, the bridge refuses to disable that
server even if your `CODEX_MCP_SERVERS` list would otherwise drop it, and emits
a loud warning to stderr. The flag is read directly from `config.toml`, so
tagging a critical server as `required = true` is the right way to make it
survive any caller's disable list.

**Per-tool defaults.** The `review` tool's agentic mode defaults to
`CODEX_MCP_SERVERS=serena` so symbol navigation is available during review
without you having to set the env var. Pass the `mcpServers` tool parameter
to override per-invocation (e.g. `"ck-search,serena"` for deeper review, or
`"inherit"` to debug). Quick review mode and all other tools stay disable-all.

**Why per-server enumeration instead of `mcp_servers={}`?** On older Codex
versions a blanket `-c mcp_servers={}` override silently no-ops: config
merging preserves the existing server table rather than replacing it
(upstream [openai/codex#16045](https://github.com/openai/codex/issues/16045)).
Per-server `enabled=false` is the only reliable disable path.

**Grammar narrowing (unreleased).** Older builds of the bridge treated *any*
non-empty non-`inherit` value as raw TOML. From this release on, only values
whose first non-whitespace char is `{` or `[` are treated as raw TOML; every
other non-keyword value is a comma-separated enable list. The env var was
unreleased when the grammar changed.

If `$CODEX_HOME/config.toml` fails to parse, the bridge throws an actionable
error. Set `CODEX_MCP_SERVERS=inherit` to bypass the override entirely.

## Performance

Each tool invocation spawns a fresh Codex CLI process. Codex CLI has minimal startup overhead (<100ms), so wall time is dominated by model inference.

Approximate timings with `o4-mini` (Codex CLI default). Actual times vary with model load and network conditions.

| Scenario | Typical time | Tokens in |
|----------|-------------|-----------|
| Trivial prompt ("pong") | 9-12s | 32K |
| Quick review, small diff (1KB) | ~20s | 32K |
| Quick review, medium diff (24KB) | ~35s | 38K |
| Quick review, large diff (54KB) | ~40s | 47K |
| Web search | ~17s | 36K |

Inference time scales sub-linearly with diff size. The default timeouts (60-300s) are comfortable for typical workloads.

## Security

- **Env allowlist**: Only explicit keys forwarded to subprocess (no wildcard `OPENAI_*`)
- **Path sandboxing**: All file paths resolved via `realpath` with root boundary check
- **Shell: false**: Always `spawn()` with args array, never shell execution
- **Concurrency**: Max 3 concurrent, FIFO queue, 30s queue timeout
- **Timeouts**: Per-tool defaults, 600s hard cap. SIGTERM -> 5s grace -> SIGKILL
- **File limits**: 1MB text, 5MB image, 20 files max
- **Log redaction**: Strips potential secrets (API keys, tokens) from CLI output

## Development

```bash
npm install
npm run build        # Compile TypeScript
npm run dev          # Watch mode
npm test             # Run tests
npm run lint         # ESLint
npm run typecheck    # tsc --noEmit
```

## How does this compare to other Codex MCP servers?

| | codex-mcp-bridge | [@tuannvm/codex-mcp-server](https://github.com/tuannvm/codex-mcp-server) |
|---|---|---|
| **Review mode** | Agentic (CLI explores repo in full-auto) | Diff text sent to CLI |
| **Structured output** | JSON Schema validated (Ajv) | threadId forwarding |
| **Model fallback** | Auto-retry with fallback model | No |
| **Concurrency** | Max 3, FIFO queue | Unbounded |
| **Output parsing** | Multi-strategy (JSONL/JSON/text fallback) | Basic stderr capture |
| **Prompt templates** | Editable .md files | Hardcoded |
| **Security** | Env allowlist, path sandboxing, log redaction | Basic |
| **Tests** | High coverage including spawn | ~50% coverage |

**When to pick codex-mcp-bridge**: You want agentic code review where Codex explores the repo itself, structured output with schema validation, or hardened subprocess management.

**When to pick @tuannvm/codex-mcp-server**: You want a lighter wrapper with fewer opinions, or you're already using it and it meets your needs.

Know of another Codex MCP server? Open an issue and we'll add it to the table.

## License

MIT
