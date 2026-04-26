import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";

/**
 * MCP tool annotations for all codex-mcp-bridge tools.
 *
 * Annotations are hints that help MCP clients understand tool behavior
 * for permission prompts, safety checks, and orchestration decisions.
 * Values reflect worst-case behavior (e.g. codex defaults to read-only
 * but accepts workspace-write/full-auto).
 */

export const codexAnnotations: ToolAnnotations = {
  title: "Codex CLI",
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
};

export const searchAnnotations: ToolAnnotations = {
  title: "Web Search",
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

export const structuredAnnotations: ToolAnnotations = {
  title: "Structured Output",
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
};

export const listSessionsAnnotations: ToolAnnotations = {
  title: "List Sessions",
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

export const queryAnnotations: ToolAnnotations = {
  title: "Quick Query",
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
};

export const pingAnnotations: ToolAnnotations = {
  title: "Health Check",
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};
