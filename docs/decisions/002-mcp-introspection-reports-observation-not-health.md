# ADR-002: Report observed MCP state, never an inferred health verdict

**Status**: Proposed
**Date**: 2026-08-03

## Context

The `mcpStatus` tool reports what Codex sees about the MCP servers in a user's
`~/.codex/config.toml`. It reads two sources from the experimental `codex
app-server` protocol, and they differ in how much they can be trusted.

- `mcpServerStatus/list` returns an inventory: server names, `authStatus`, a
  tool map, and an optional `serverInfo`. It answers "what does Codex have
  right now".
- `mcpServer/startupStatus/updated` notifications carry an explicit
  `ready` / `failed` plus a free-form error string naming the cause. They
  require an active thread, so the cheap no-thread path cannot see them.

Two properties of that protocol are load-bearing and hold as long as the
upstream surface behaves as measured:

1. **The inventory is not a health oracle.** `serverInfo` is absent for servers
   that failed, which makes it look like a health bit. It is also absent,
   intermittently, for servers that are demonstrably running: under a slow
   `mcpServerStatus/list` the response omits `serverInfo` and returns an empty
   tool map for servers that emitted an explicit `ready` in the same session.
   The two sources therefore disagree on live data, and the inventory is the
   side that is wrong.
2. **A wrong failure costs more than a missing verdict.** This tool exists so
   nobody has to read Codex logs by hand to find out why a server is missing.
   Reporting a working server as broken sends a reader to debug something that
   is not there, which is worse than the state quo of no report at all. The
   asymmetry is not symmetric noise: it is one-directional, and it worsens
   exactly when the machine is loaded, which is when someone is most likely to
   be diagnosing something.

A third force applies to the subprocess, not the protocol. MCP servers read
their credentials from the environment (`bearer_token_env_var`,
`mcp_servers.NAME.env`). The bridge's normal subprocess environment is a strict
allowlist (see `AGENTS.md` § Subprocess Environment). A child launched under
that allowlist is not the child the user runs, so what it reports is a property
of the bridge's reconstruction rather than of the user's configuration.

## Decision

`mcpStatus` reports observation, and refuses to infer.

- Server state is `initialized`, `failed`, or `unknown`. **`failed` is emitted
  only on an explicit `failed` notification.** An absent `serverInfo` yields
  `unknown`, never `failed`.
- Where the inventory and a notification disagree, the notification wins and the
  disagreement is surfaced in the response rather than silently resolved.
- The response carries the duration of the underlying call and a `degraded`
  flag, so a reader can tell a confident `unknown` from a suspect one.
- The introspection subprocess inherits the full environment
  (`buildIntrospectionEnv()`), as a deliberate and narrow exception to the
  allowlist. It is bounded by the fact that this path submits no turn, so no
  environment value reaches a model, and by redacting every error string the
  path returns. It applies to no other tool.

## Alternatives considered

- **Treat `serverInfo` presence as health.** Rejected: it produces a
  one-directional false-failure under load, and the failure is silent. A
  reporting tool that invents failures is worse than one that admits ignorance.
- **Treat an empty tool map as failure.** Rejected: a server exposing only
  resources is legitimately tool-less, so this misreads a whole valid class of
  server. It also inherits the same doubt as `serverInfo`, since both go missing
  together.
- **Always run the diagnostic (thread) path so a verdict is always available.**
  Rejected: it costs several times the cheap path, creates a thread per call,
  and forces every caller who wants an inventory to pay for a diagnosis.
- **Harden the introspection subprocess like every other tool.** Rejected: it
  strips the credentials the servers under test read, so the tool reports
  failures caused by the bridge rather than by the user's configuration, which
  defeats the tool's only purpose.
- **Suppress MCP servers for speed, as the other tools do.** Rejected for the
  same reason: it disables the thing being measured.

## Consequences

- Callers get a state they can act on. `failed` always carries a real
  diagnostic; `unknown` is an honest admission, not a soft failure, and the
  tool description says so.
- The cheap default path cannot report failures at all. That is the price of it
  being cheap, and the tool points the caller at `diagnostics: true` when they
  need a verdict.
- The `degraded` flag is a heuristic calibrated on measured behaviour, not a
  guarantee. If the upstream slow-call defect is fixed, the flag becomes dead
  weight and should be removed rather than left to rot.
- The environment exception is a standing carve-out in a security-critical
  invariant. It is safe only while this path submits no turn. **If introspection
  ever grows a model call, this ADR is void and the exception must go.**
- Results describe what a newly spawned Codex process sees. A user's existing
  interactive session may differ on version, cwd, config snapshot, or auth
  state.
- The protocol is experimental, so every shape above is version-bound. A schema
  drift test regenerates from the installed CLI rather than comparing a
  committed fixture against itself.
