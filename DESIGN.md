# Design

Architecture and implementation details for codex-mcp-bridge.

## Architecture

```
MCP Client  --stdio-->  codex-mcp-bridge  --spawn-->  codex CLI subprocess
```

The bridge assembles prompts in TypeScript and spawns the Codex CLI as a subprocess. The `codex` tool can run in `read-only`, `workspace-write`, or `full-auto` sandbox modes; the other prompt-driven tools spawn into isolated read-only contexts. The bridge captures output, parses it, and returns structured MCP responses.

For code review the bridge has no opinion on prompt content. MCP-only clients can use the `review` tool, which wraps upstream `codex exec review --json` without accepting a prompt. Free-form review still goes through the `codex` tool with `sandbox: "read-only"` and a caller-supplied prompt. See [README § Code review with this CLI](README.md#code-review-with-this-cli) and [ADR-001](docs/decisions/001-remove-review-and-assess-tools.md).

## Subprocess Spawning

- Always `spawn()` with `shell: false`, args as array (never `exec()`)
- Large prompts piped via stdin to avoid `ARG_MAX` limits
- Kill process group on timeout: SIGTERM, 5s grace period, then SIGKILL
- `NO_COLOR=1` and `FORCE_COLOR=0` set for every spawn

## Streaming app-server Transport

`mcpStatus` cannot use the spawn path above. That path writes stdin then closes
it, and buffers all stdout into a string until `close`. `codex app-server` needs
the opposite: stdin held open for the session, stdout parsed line-by-line as
JSONL, requests correlated to responses by `id`, and notifications interleaved
throughout. `src/utils/app-server.ts` is therefore a separate subsystem rather
than a flag on `spawnCodex`.

- One `AppServerSession` owns one child and holds **one concurrency slot** for
  its whole lifetime, so introspection competes with `query` / `search` /
  `review` on the same budget. The slot is released exactly once, including on
  spawn failure and repeated `close()`.
- Requests carry their own timeout and drop their pending entry when it fires,
  so a late response cannot resolve a caller that already gave up.
- A dead child turns the next stdin write into an EPIPE `error` event. That is
  handled explicitly: unhandled, it is an uncaught exception that kills the
  whole bridge rather than the one session.
- Teardown is SIGTERM, 5s grace, then SIGKILL, against the process group on
  Unix so the child's own MCP servers go with it.

The protocol is JSON-RPC-shaped but omits `jsonrpc`, and `initialize` requires
only `clientInfo`. It is experimental upstream, so `tests/utils/appserver-schema-drift.test.ts`
regenerates the schema from the installed CLI and diffs the definitions the
bridge parses. See [ADR-002](docs/decisions/002-mcp-introspection-reports-observation-not-health.md)
for the reporting contract these shapes feed.

## Output Parsing

Multi-strategy parsing with cascading fallback:

1. **JSONL events** (stdout primary, stderr fallback): Codex emits structured events during execution
2. **JSON parsing**: Falls back to parsing the full output as JSON
3. **Plain text**: Last resort, returns raw text output

The parser tolerates malformed JSON and extracts response text from partial output. Potential secrets (API keys, Bearer tokens) are redacted from CLI output before being returned.

## Concurrency

Requests are managed by a FIFO queue:
- **Max concurrent**: 3 subprocess spawns (configurable via `CODEX_MAX_CONCURRENT`)
- **Queue timeout**: 30s (requests that can't acquire a slot within 30s are rejected)
- **Timeout enforcement**: Per-tool defaults, 600s (10 min) hard cap
- **Cleanup**: Timed-out processes killed with SIGTERM, then SIGKILL after 5s. On Unix, the entire process group is killed to clean up child processes.

## Model Fallback

When the primary model returns a quota exhaustion error, the bridge automatically retries with `CODEX_FALLBACK_MODEL` (default: `o3`). Set to `none` to disable. The `_meta.fallbackUsed` field indicates whether fallback was triggered.

## Sessions

Session state is tracked in-memory across calls. When the `codex` tool returns a `sessionId` in `_meta`, pass it back on subsequent calls to resume the conversation. Codex's native `conversationId` is captured from stderr and used for `codex exec resume`.

- **TTL**: 24 hours of inactivity
- **Capacity**: LRU eviction at 100 sessions
- **Reset**: Pass `resetSession: true` to discard stored state
- **Listing**: The `listSessions` tool exposes session metadata (id, model, timestamps, turn count)
- **Ephemeral**: Session state is in-memory only, lost on server restart

## Response Metadata

All tools attach an `_meta` object to the MCP `CallToolResult`:

| Field | Type | Present on |
|-------|------|------------|
| `durationMs` | number | All tools |
| `model` | string | Tools that run Codex CLI |
| `fallbackUsed` | boolean | Tools that run Codex CLI |
| `sessionId` | string | `codex` tool only |
| `conversationId` | string | `codex` tool only |
| `threadId` | string | `review` tool only |
| `eventCounts` | object | `review` tool only |
| `commands` | array | `review` tool only, redacted |

## MCP Annotations

All tools declare [MCP tool annotations](https://modelcontextprotocol.io/specification/2025-03-26/server/tools#annotations) so clients can make informed permission and safety decisions:

| Tool | readOnlyHint | destructiveHint | openWorldHint |
|------|-------------|----------------|---------------|
| codex | false | true | true |
| search | true | false | true |
| query | true | false | true |
| review | false | true | true |
| structured | true | false | true |
| ping | true | false | false |
| listSessions | true | false | false |

The `codex` tool is marked destructive because its `workspace-write` and `full-auto` sandbox modes can write files. The `review` tool is also marked destructive because it invokes Codex's native review with `--full-auto` so the non-interactive subprocess can inspect diffs. Most tools are `openWorldHint: true` since they spawn a CLI that can access files and network.

## Progress Notifications

The `codex`, `search`, `query`, and `review` tools emit MCP `notifications/progress` every 15 seconds when the client provides a `progressToken` in the request's `_meta`. Heartbeats include elapsed time. Notifications are fire-and-forget; clients that don't support progress notifications are unaffected.

Implemented in `src/utils/progress.ts`.

## Codex Internal MCP Server Control

When the bridge spawns Codex, any MCP servers configured in `~/.codex/config.toml` (`[mcp_servers.*]`), or in the `.codex/config.toml` of a trusted project around the spawn's working directory, would otherwise load inside Codex and add 30-120s of startup overhead per call. The `CODEX_MCP_SERVERS` env var controls which servers stay enabled.

### Grammar

Branches evaluated top-to-bottom:

| Mode | Value | Behavior |
|------|-------|----------|
| **Disable-all** (default) | unset / empty / whitespace | Disable every configured server except those marked `required = true` |
| **Inherit** | `inherit` (exact, case-sensitive) | Pass through config unchanged |
| **Raw TOML** | value starting with `{` or `[` | Forwarded verbatim as `-c mcp_servers=<value>` |
| **Selective enable** | comma-separated names | Enable listed servers, disable all others (except required) |

### Per-tool defaults

All tools use disable-all by default. The `codex` tool inherits from the `CODEX_MCP_SERVERS` env var; pass `mcpServers: "inherit"` (when supported by upstream) to debug.

### Required servers

Codex PR [#10902](https://github.com/openai/codex/pull/10902) added a `required = true` flag under `[mcp_servers.NAME]`. When set in the user, system (`/etc/codex/config.toml`) or managed (`/etc/codex/managed_config.toml`) config, the last of those setting it winning as Codex's merge does, the bridge refuses to disable that server regardless of `CODEX_MCP_SERVERS` value, and emits a warning to stderr. A project `.codex/config.toml` cannot grant that exemption: the bridge cannot tell which project layers Codex loaded, and an explicitly untrusted subdirectory's `required = true` would otherwise keep a trusted parent's server running. Disabling a server a trusted project marks required starts cleanly (measured on `codex-cli 0.163.0`).

### Why per-server enumeration, in one table?

An empty `-c mcp_servers={}` override silently no-ops: config merging preserves the existing server table rather than replacing it (upstream [openai/codex#16045](https://github.com/openai/codex/issues/16045), still true on `codex-cli 0.163.0`, for user and project servers alike). The same merge is what makes a **non-empty** table work: `-c 'mcp_servers={drop={enabled=false}, keep={enabled=true}}'` merges into the loaded tables, so `keep` keeps its own `command` and `args` and an omitted `required` server is untouched (measured on 0.163.0). So the bridge names every server, in one inline table:

```
-c mcp_servers={github={enabled=false}, "my.server"={enabled=false}, serena={enabled=true}}
```

Names go inside the value, never in the `-c` key path. Codex's `-c` parser splits the argument on the first `=` and the path on `.` without unquoting, so a quoted key in the path arrives as literal characters: `mcp_servers."my.server".enabled=false` creates a server called `"my` with no transport and Codex refuses to start, and a name like `x={command='...',enabled=true}#` injected an enabled server. The value side is parsed as real TOML, so any name round-trips.

### Project-declared servers

Codex loads `[mcp_servers.*]` from a project's `.codex/config.toml` (each directory between the working directory and the project root) when the project is trusted in user config. Trust is matched on the directory itself, the project root (nearest `.git` by default) or the repository root, so trusting a parent such as `/home/me` covers its non-repository subdirectories but not a separate repository below it.

The bridge does not reproduce the trust decision. Every spawning tool passes its working directory, and the bridge reads every `.codex/config.toml` from its realpath (Codex sees the physical path) up to the project root, found as Codex's `discover_project_root` finds it: the nearest ancestor holding any of `project_root_markers` (default `[".git"]`; a linked worktree's `.git` file counts, a `.git` directory only with a `HEAD`; an absolute marker is checked as given, as Rust's `Path::join` replaces the base with it, and so is `~` or `~/rest` once expanded against the home directory, as Codex's `AbsolutePathBuf::join` expands them (`~user` is left alone); an empty array, or no marker found, means the working directory alone). That is a superset of what any trust decision loads, and it stops where Codex stops: a file above the root, such as a world-writable `/tmp/.codex/config.toml` over a checkout in `/tmp`, is never loaded by Codex and is not read. Over-enumerating within the root is safe only because of how each project-only server is disabled:

```
-c mcp_servers={NAME={enabled=false, command="<its own command>"}}
```

A bare `enabled=false` for a server Codex did not load (an untrusted project) creates a table with no transport, and Codex refuses to start with `invalid transport`. Re-stating the server's own `command` or `url` keeps the table valid whether or not the layer loaded; the other transport kind fails with `url is not supported for stdio`. A disabled server never spawns, so this cannot start anything the trust gate kept off.

Servers declared in the system or managed config are handled like user servers: always loaded, disabled by name, and any project declaration of the same name is ignored, conflict check included, since re-stating a project file's transport over theirs makes Codex refuse to start when the kinds differ. `project_root_markers` is resolved with Codex's precedence as far as the bridge can see it: `/etc/codex/managed_config.toml` over the user config over `/etc/codex/config.toml`, the last layer setting it winning, each system file read through the same bounded, fail-closed reader as a project file. Managed configuration that is not a file (macOS managed preferences, enterprise cloud config bundles) and the Windows system config are not read, so a marker set only there can still put the bridge's root somewhere other than Codex's.

Where several project files declare one server, the transport comes from the nearest, as Codex merges nearer layers on top. If they disagree on its kind (`command` in one, `url` in another), the spawn is refused with an error naming both files: the bridge cannot tell which layer Codex loads, and re-stating the wrong kind makes Codex refuse to start (`url is not supported for stdio`). Project files are read only if they are regular files (a symlink to one is followed, as Codex follows it) of at most 1 MiB, checked before and after a non-blocking open, because the bridge reads them synchronously before any subprocess timeout starts and a FIFO or `/dev/zero` would otherwise stall or exhaust it. Integers are parsed losslessly, since Codex accepts values past 2^53.

**Enumeration fails closed.** A project file that exists on the walk but is rejected (not a regular file, over the cap, unreadable, unparseable) refuses the spawn with an error naming the file, because Codex may load it and its servers would then start unsuppressed. An absent file is a no-op, and `CODEX_MCP_SERVERS=inherit` reads no config at all, so it is the escape hatch. The same holds when the override would exceed Linux's 128 KiB limit on one argument: a clear error instead of a raw `E2BIG` from the spawn.

**Managed config is admin policy above every CLI override.** Codex merges `/etc/codex/managed_config.toml` on top of `-c` (its loader: "Managed config wins over CLI config"), so a managed `enabled = true` keeps a server running whatever the bridge emits, and a managed `enabled = false` keeps one off even when the caller asks to enable it. The bridge does not fight that or refuse the call: it emits the same argv, and in the disable-all and selective-enable modes, unless `silent`, it prints at most one warning per direction per spawn (so up to two), naming the servers managed config keeps on and those it keeps off. Raw TOML and `inherit` modes read no config and print no such warning.

Enumeration and Codex's own load are separate reads, so a config changed between them is not covered. That race is not closable from outside Codex.

A project file never changes how a server the user config also declares is handled, `required` included, since that file may be one Codex did not load.

A project-only server named in the selective-enable list gets no override at all. `enabled=true` alone breaks startup when the project is untrusted, and with a transport it would start a server Codex declined to load. It runs only when Codex loaded it and its own config leaves it enabled.

## Prompt Templates

The `search` and `query` tools load prompt templates from the `prompts/` directory. Templates are filled with placeholders. Editable when running from a local clone; bundled when running via `npx`. The `codex` tool is fully caller-driven: no bridge-side templates.
