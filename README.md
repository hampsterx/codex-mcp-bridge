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

### codex

General-purpose execution. Supports multi-turn conversations via session IDs, sandbox levels (`read-only`, `workspace-write`, `full-auto`), and reasoning effort control.

### review

Two modes:

- **Agentic (default)**: Codex CLI runs in `--full-auto` mode inside the repo. It runs `git diff`, reads full files, follows imports, checks tests, and reads project instruction files before reviewing.
- **Quick** (`quick: true`): Sends only the diff text. Single-pass, no repo exploration.

### search

Web search powered by Codex CLI's `--search` flag. Returns synthesized answers with source URLs.

### structured

Embeds a JSON Schema in the prompt and validates the response with Ajv. Returns the raw JSON on success, validation errors on failure.

## Configuration

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| `CODEX_DEFAULT_MODEL` | _(CLI default)_ | Default model for all tools |
| `CODEX_FALLBACK_MODEL` | `o3` | Fallback on quota exhaustion. `none` to disable |
| `CODEX_CLI_PATH` | `codex` | Path to Codex CLI binary |
| `CODEX_MAX_CONCURRENT` | `3` | Max concurrent subprocess spawns |

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

## Comparison with codex-mcp-server

| Aspect | codex-mcp-server | codex-mcp-bridge |
|--------|-----------------|------------------|
| **Review** | Sends diff text to CLI | Agentic: CLI explores repo in full-auto |
| **Security** | No env filtering, no path validation | Env allowlist, path sandboxing, log redaction |
| **Concurrency** | Unbounded spawns | Max 3, FIFO queue |
| **Output parsing** | Basic stderr capture | Multi-strategy (JSONL/JSON/text fallback) |
| **Model fallback** | None | Auto-retry with fallback model |
| **Prompt templates** | Hardcoded | Editable .md files |
| **Structured output** | threadId forwarding only | JSON Schema validated (Ajv) |
| **Tests** | ~50% coverage | High coverage including spawn |

## License

MIT
