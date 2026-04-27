# codex-mcp-bridge

[![npm version](https://img.shields.io/npm/v/codex-mcp-bridge)](https://www.npmjs.com/package/codex-mcp-bridge)
[![npm downloads](https://img.shields.io/npm/dm/codex-mcp-bridge)](https://www.npmjs.com/package/codex-mcp-bridge)
[![CI](https://github.com/hampsterx/codex-mcp-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/hampsterx/codex-mcp-bridge/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/node/v/codex-mcp-bridge)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![MCP](https://img.shields.io/badge/MCP-compatible-8A2BE2)](https://modelcontextprotocol.io/)

MCP server that wraps [Codex CLI](https://github.com/openai/codex) as a subprocess, exposing code execution, web search, and structured output as [Model Context Protocol](https://modelcontextprotocol.io/) tools.

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

# From a worktree (run inside the worktree; `-C` is broken for `review`)
cd /path/to/worktree && codex review --base main

# General analysis
codex exec "Analyze src/utils/parse.ts for edge cases"
```

**Use this MCP bridge instead when:**
- Your client has no shell access (Cursor, Windsurf, Claude Desktop, VS Code)
- You need structured output with JSON Schema validation (Codex CLI's `--json` has [known bugs](https://github.com/openai/codex/issues/16552))
- You need partial response capture on timeout and automatic model fallback on
  quota exhaustion
- You want subprocess isolation: explicit env allowlist, no shell escape,
  secret redaction on output, FIFO-queued concurrency (max 3 parallel spawns,
  configurable via `CODEX_MAX_CONCURRENT`)
- You need multi-turn conversations via session resume (`sessionId` /
  `resetSession`, inspected via `listSessions`)

Worktree note: Codex CLI issue [#9084](https://github.com/openai/codex/issues/9084)
breaks `codex -C /path review ...`. Run `codex review` from inside the worktree to avoid it.

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
| **codex** | Execute prompts with file context, session resume, and sandbox control. Multi-turn conversations via session IDs. Use for free-form review prompts; see [Code review with this CLI](#code-review-with-this-cli). |
| **review** | Native diff-aware Codex review via `codex exec review --json`. No caller prompt; supports uncommitted, base branch, and commit review modes. |
| **search** | Web search via `codex --search`. Returns synthesized answers with source URLs. |
| **query** | Lightweight text analysis. No repo context, no sessions. Runs in an isolated temp directory. |
| **structured** | JSON Schema validated output via [Ajv](https://ajv.js.org/). Data extraction, classification, or any task needing machine-parseable output. |
| **ping** | Health check with CLI version, capabilities, and concurrency diagnostics (`activeCount`, `queueDepth`). |
| **listSessions** | List active conversation sessions with metadata (turn count, model, timestamps). |

### codex

General-purpose execution. Supports multi-turn conversations via `sessionId`, sandbox levels (`read-only`, `workspace-write`, `full-auto`), and reasoning effort control. Pass `resetSession: true` to discard and start fresh. Use `listSessions` to inspect active sessions before resuming.

Key parameters: `prompt` (required), `files`, `model`, `sessionId`, `sandbox`, `reasoningEffort`, `workingDirectory`, `timeout` (default 60s).

### search

Web search powered by OpenAI's native search infrastructure via Codex CLI's `--search` flag. Returns synthesized answers with source URLs.

Key parameters: `query` (required), `model`, `workingDirectory`, `timeout` (default 120s).

### query

Lightweight, non-agentic text analysis. Spawns in an isolated temp directory so the bridge's repo context doesn't leak. Pass text to analyze in the `context` parameter. Supports `reasoningEffort` and `maxResponseLength`.

Key parameters: `prompt` (required), `context`, `model`, `reasoningEffort`, `timeout` (default 60s).

### review

Thin wrapper around Codex CLI's native diff-aware review. The bridge passes the diff selector to `codex exec review --json`; upstream Codex owns the review prompt. Requires a real git repository via `workingDirectory`.

Key parameters: `mode` (required: `uncommitted`, `base`, or `commit`), `workingDirectory` (required), `base` (required for `base` mode), `commit` (required for `commit` mode), `title`, `model`, `timeout` (default 180s).

### structured

Embeds a JSON Schema in the prompt and validates the response with Ajv. Returns clean JSON on success, validation errors on failure.

Key parameters: `prompt` (required), `schema` (required, JSON string), `files`, `model`, `workingDirectory`, `timeout` (default 60s).

### ping

No parameters. Returns CLI version, auth status, model configuration, and concurrency diagnostics (`activeCount`, `queueDepth`).

All tools attach execution metadata (`_meta`) with `durationMs`, `model`, `fallbackUsed`, and session info where applicable. See [DESIGN.md](DESIGN.md) for details.

## Code review with this CLI

This bridge does not bundle reviewer prompts. There are three paths for code review:

### Native upstream `codex review`

```bash
codex review --base main
codex review --uncommitted
codex review --base main "Focus on security and error handling"
```

Diff-aware review built into Codex CLI. No bridge involvement. Use this when your client has shell access.

### Bridge `review` tool for native diff-aware review

```jsonc
{
  "tool": "review",
  "arguments": {
    "mode": "base",
    "base": "main",
    "workingDirectory": "/path/to/worktree"
  }
}
```

The bridge runs `codex exec review --json` from `workingDirectory`, captures the final review text, and returns review metadata such as `threadId`, event counts, and redacted command output. It does not accept a prompt.

### Bridge `codex` tool with caller-supplied prompt

```jsonc
{
  "tool": "codex",
  "arguments": {
    "prompt": "<your review prompt + diff or file references>",
    "sandbox": "read-only"
  }
}
```

The bridge runs `codex exec --sandbox read-only` with the supplied prompt and returns stdout. Use this for free-form review prompts or review inputs that are not expressible as `uncommitted`, `base`, or `commit` diff selectors.

### Representative review prompt

A starting point; adapt freely:

```text
Review the following diff:

<diff content>

Look for:
- Bugs that would surface in production
- Missing error handling on user-supplied input
- Tests modified to silence failures rather than verify behaviour
- Security issues (injection, missing auth checks, secret leaks)

For each finding cite file:line, severity (high/medium/low), and a suggested fix.
Skip style/formatting; assume an autoformatter handles those.
```

The bridge has no opinion on prompt content. See [ADR-001](docs/decisions/001-remove-review-and-assess-tools.md) for the rationale.

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
| Structured output, model fallback, concurrency management, session resume | This bridge |
| Session threading with `conversationId`, callback URI forwarding | [@tuannvm/codex-mcp-server](https://github.com/tuannvm/codex-mcp-server) |
| Structured patch output with approval policies | [cexll/codex-mcp-server](https://github.com/cexll/codex-mcp-server) |
| Minimal `codex exec` wrapper with parallel subagents | [codex-as-mcp](https://github.com/kky42/codex-as-mcp) |
| Native Codex MCP (experimental, no wrapper needed) | `codex mcp serve` ([docs](https://github.com/openai/codex)) |

## Performance

Codex CLI has minimal startup overhead (<100ms), so wall time is dominated by model inference.

| Scenario | Typical time |
|----------|-------------|
| Trivial prompt | 9-12s |
| Web search | ~17s |

Default timeouts (60-300s) are comfortable for typical workloads.

## Bridge family

Three MCP servers, same architecture, different underlying CLIs. Each wraps a terminal agent as a subprocess and exposes it as MCP tools. Pick the one that matches your model provider, or run multiple for cross-model workflows.

| | [codex-mcp-bridge](https://github.com/hampsterx/codex-mcp-bridge) | [claude-mcp-bridge](https://github.com/hampsterx/claude-mcp-bridge) | [gemini-mcp-bridge](https://github.com/hampsterx/gemini-mcp-bridge) |
|---|---|---|---|
| **CLI** | Codex CLI | Claude Code | Gemini CLI |
| **Provider** | OpenAI | Anthropic | Google |
| **Tools** | codex, review, search, query, structured, ping, listSessions | query, review, search, structured, ping, listSessions | query, review, search, structured, ping, fetchChunk |
| **Code review** | `review` tool wrapping native `codex exec review --json`, or `codex` tool with caller-supplied prompt | `review` tool with caller-supplied prompt and hardened isolation defaults | `review` tool with caller-supplied prompt and hardened defaults |
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
