# codex-mcp-bridge

[![npm version](https://img.shields.io/npm/v/codex-mcp-bridge)](https://www.npmjs.com/package/codex-mcp-bridge)
[![npm downloads](https://img.shields.io/npm/dm/codex-mcp-bridge)](https://www.npmjs.com/package/codex-mcp-bridge)
[![CI](https://github.com/hampsterx/codex-mcp-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/hampsterx/codex-mcp-bridge/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/node/v/codex-mcp-bridge)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![MCP](https://img.shields.io/badge/MCP-compatible-8A2BE2)](https://modelcontextprotocol.io/)

MCP server that wraps [Codex CLI](https://github.com/openai/codex) as a subprocess, exposing code execution, agentic review, web search, and structured output as [Model Context Protocol](https://modelcontextprotocol.io/) tools.

Works with any MCP client: Claude Code, Gemini CLI, Cursor, Windsurf, VS Code, or any tool that speaks MCP.

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

### Prerequisites

- [Codex CLI](https://github.com/openai/codex) installed (`npm i -g @openai/codex`)
- `OPENAI_API_KEY` environment variable set, or `codex auth login` completed

### Claude Code

```bash
claude mcp add codex-bridge -- npx -y codex-mcp-bridge
```

### Gemini CLI

Add to `~/.gemini/settings.json`:
```json
{
  "mcpServers": {
    "codex-bridge": {
      "command": "npx",
      "args": ["-y", "codex-mcp-bridge"]
    }
  }
}
```

### Cursor / Windsurf / VS Code

Add to your MCP settings:
```json
{
  "codex-bridge": {
    "command": "npx",
    "args": ["-y", "codex-mcp-bridge"],
    "env": {
      "OPENAI_API_KEY": "sk-..."
    }
  }
}
```

## Tools

| Tool | Description |
|------|-------------|
| **codex** | Execute prompts with file context, session resume, and sandbox control. Multi-turn conversations via session IDs. |
| **review** | Agentic code review. Codex runs in full-auto inside the repo: diffs, reads files, follows imports, checks tests. Quick diff-only mode available. |
| **search** | Web search via `codex --search`. Returns synthesized answers with source URLs. |
| **query** | Lightweight text analysis. No repo context, no sessions. Runs in an isolated temp directory. |
| **structured** | JSON Schema validated output via [Ajv](https://ajv.js.org/). Data extraction, classification, or any task needing machine-parseable output. |
| **ping** | Health check with CLI version, capabilities, and concurrency diagnostics (`activeCount`, `queueDepth`). |
| **listSessions** | List active conversation sessions with metadata (turn count, model, timestamps). |

### codex

General-purpose execution. Supports multi-turn conversations via `sessionId`, sandbox levels (`read-only`, `workspace-write`, `full-auto`), and reasoning effort control. Pass `resetSession: true` to discard and start fresh. Use `listSessions` to inspect active sessions before resuming.

Key parameters: `prompt` (required), `files`, `model`, `sessionId`, `sandbox`, `reasoningEffort`, `workingDirectory`, `timeout` (default 60s).

### review

Two modes:
- **Agentic** (default): Codex runs in `--full-auto` inside the repo. It diffs, reads files, follows imports, checks tests, and reads project instruction files before reviewing. Timeout auto-scales from diff size.
- **Quick** (`quick: true`): Diff-only review, no repo exploration. Faster but less context.

Key parameters: `uncommitted` (default true), `base`, `focus`, `quick`, `workingDirectory`, `timeout` (default 300s agentic, 120s quick).

### search

Web search via Codex CLI's `--search` flag. Returns synthesized answers with source URLs.

Key parameters: `query` (required), `model`, `workingDirectory`, `timeout` (default 120s).

### query

Lightweight, non-agentic text analysis. Spawns in an isolated temp directory so the bridge's repo context doesn't leak. Pass text to analyze in the `context` parameter. Supports `reasoningEffort` and `maxResponseLength`.

Key parameters: `prompt` (required), `context`, `model`, `reasoningEffort`, `timeout` (default 60s).

### structured

Embeds a JSON Schema in the prompt and validates the response with Ajv. Returns clean JSON on success, validation errors on failure.

Key parameters: `prompt` (required), `schema` (required, JSON string), `files`, `model`, `workingDirectory`, `timeout` (default 60s).

### ping

No parameters. Returns CLI version, auth status, model configuration, and concurrency diagnostics (`activeCount`, `queueDepth`).

All tools attach execution metadata (`_meta`) with `durationMs`, `model`, `fallbackUsed`, and session info where applicable. See [DESIGN.md](DESIGN.md) for details.

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `CODEX_DEFAULT_MODEL` | *(CLI default)* | Default model for all tools |
| `CODEX_FALLBACK_MODEL` | `o3` | Fallback on quota exhaustion (`none` to disable) |
| `CODEX_CLI_PATH` | `codex` | Path to CLI binary |
| `CODEX_MAX_CONCURRENT` | `3` | Max concurrent subprocess spawns |
| `CODEX_MCP_SERVERS` | *(unset)* | Control which Codex internal MCP servers stay enabled. See [DESIGN.md](DESIGN.md#codex-internal-mcp-server-control). |

## Choosing a Codex MCP server

| You need... | Consider |
|-------------|----------|
| Agentic code review, structured output, model fallback, concurrency management | This bridge |
| Session threading with `conversationId`, callback URI forwarding | [@tuannvm/codex-mcp-server](https://github.com/tuannvm/codex-mcp-server) |
| Structured patch output with approval policies | [cexll/codex-mcp-server](https://github.com/cexll/codex-mcp-server) |
| Minimal `codex exec` wrapper with parallel subagents | [codex-as-mcp](https://github.com/kky42/codex-as-mcp) |
| Native Codex MCP (experimental, no wrapper needed) | `codex mcp serve` ([docs](https://github.com/openai/codex)) |

## Performance

Codex CLI has minimal startup overhead (<100ms), so wall time is dominated by model inference.

| Scenario | Typical time |
|----------|-------------|
| Trivial prompt | 9-12s |
| Quick review, small diff (1KB) | ~20s |
| Quick review, medium diff (24KB) | ~35s |
| Quick review, large diff (54KB) | ~40s |
| Web search | ~17s |

Default timeouts (60-300s) are comfortable for typical workloads.

## Bridge family

Three MCP servers, same architecture, different underlying CLIs. Each wraps a terminal agent as a subprocess and exposes it as MCP tools. Pick the one that matches your model provider, or run multiple for cross-model workflows.

| | [codex-mcp-bridge](https://github.com/hampsterx/codex-mcp-bridge) | [claude-mcp-bridge](https://github.com/hampsterx/claude-mcp-bridge) | [gemini-mcp-bridge](https://github.com/hampsterx/gemini-mcp-bridge) |
|---|---|---|---|
| **CLI** | Codex CLI | Claude Code | Gemini CLI |
| **Provider** | OpenAI | Anthropic | Google |
| **Tools** | codex, review, search, query, structured, ping, listSessions | query, review, search, structured, ping, listSessions | query, review, search, structured, ping |
| **Agentic review** | Codex explores repo in full-auto mode | Claude explores repo with Read/Grep/Glob/git | Gemini explores repo with file reads and git |
| **Structured output** | Ajv validation | Native `--json-schema` | Ajv validation |
| **Session resume** | Session IDs with multi-turn | Native `--resume` | Not supported |
| **Budget caps** | Not supported | Native `--max-budget-usd` | Not supported |
| **Effort control** | `reasoningEffort` (low/medium/high) | `--effort low/medium/high/max` | Not supported |
| **Cold start** | <100ms (inference dominates) | ~1-2s | ~16s |
| **Auth** | `OPENAI_API_KEY` | `claude login` (subscription) or `ANTHROPIC_API_KEY` | `gemini auth login` |
| **Cost** | Pay-per-token | Subscription (included) or API credits | Free tier available |
| **Concurrency** | 3 (configurable) | 3 (configurable) | 3 (configurable) |
| **Model fallback** | Auto-retry with fallback model | Auto-retry with fallback model | Auto-retry with fallback model |

All three share: subprocess env isolation, path sandboxing, FIFO concurrency queue, MCP tool annotations, `_meta` response metadata, progress heartbeats. The codex and claude bridges also perform output redaction (secret stripping).

## Development

```bash
npm install
npm run build        # Compile TypeScript
npm run dev          # Watch mode
npm test             # Run tests
npm run lint         # ESLint
npm run typecheck    # tsc --noEmit
```

## Further reading

- [DESIGN.md](DESIGN.md) - Architecture, MCP server control grammar, sessions, output parsing, response metadata
- [SECURITY.md](SECURITY.md) - Environment isolation, path sandboxing, output redaction, resource limits
- [CHANGELOG.md](CHANGELOG.md) - Release history

## License

MIT
