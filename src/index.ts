#!/usr/bin/env node

import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { executeCodex } from "./tools/codex.js";
import { executeReview } from "./tools/review.js";
import { executeSearch } from "./tools/search.js";
import { executePing } from "./tools/ping.js";
import { executeStructured } from "./tools/structured.js";

const require = createRequire(import.meta.url);
const { version: PKG_VERSION } = require("../package.json") as { version: string };

const server = new McpServer({
  name: "codex-mcp-bridge",
  version: PKG_VERSION,
});

// --- codex tool ---

server.tool(
  "codex",
  "Execute a prompt via Codex CLI with optional file context, session resume, and sandbox control. Supports multi-turn conversations. The CLI reads AGENTS.md/CODEX.md for project context automatically.",
  {
    prompt: z.string().describe("The prompt to send to Codex"),
    files: z
      .array(z.string())
      .optional()
      .describe("File paths (text or images) relative to workingDirectory"),
    model: z.string().optional().describe("Model to use (e.g. o3, gpt-4.1)"),
    sandbox: z
      .enum(["read-only", "workspace-write", "full-auto"])
      .optional()
      .describe("Sandbox level: read-only (default), workspace-write, or full-auto (Codex CLI convenience mode for workspace-write with auto-approve)"),
    sessionId: z
      .string()
      .optional()
      .describe("Session ID to resume a previous conversation"),
    reasoningEffort: z
      .enum(["low", "medium", "high"])
      .optional()
      .describe("Reasoning effort level (maps to -c model_reasoning_effort)"),
    workingDirectory: z
      .string()
      .optional()
      .describe("Working directory for the CLI"),
    timeout: z
      .number()
      .optional()
      .describe("Timeout in milliseconds (default: 60000, max: 600000)"),
    maxResponseLength: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Soft limit on response length in words"),
  },
  async (input) => {
    try {
      const result = await executeCodex(input);
      const meta: string[] = [];
      if (result.filesIncluded.length > 0) {
        meta.push(`Files included: ${result.filesIncluded.join(", ")}`);
      }
      if (result.imagesIncluded.length > 0) {
        meta.push(`Images included: ${result.imagesIncluded.join(", ")}`);
      }
      if (result.filesSkipped.length > 0) {
        meta.push(`Files skipped: ${result.filesSkipped.join(", ")}`);
      }
      if (result.timedOut) {
        meta.push("(timed out)");
      }
      if (result.fallbackUsed) {
        meta.push(`Note: ${result.model ?? "fallback model"} used after quota exhaustion`);
      } else if (result.model) {
        meta.push(`Model: ${result.model}`);
      }
      if (result.sessionId) {
        meta.push(`Session: ${result.sessionId}`);
      }
      if (result.conversationId) {
        meta.push(`Conversation: ${result.conversationId}`);
      }

      const text = meta.length > 0
        ? `${result.response}\n\n---\n${meta.join("\n")}`
        : result.response;

      return { content: [{ type: "text", text }] };
    } catch (e) {
      return {
        content: [{ type: "text", text: `Error: ${(e as Error).message}` }],
        isError: true,
      };
    }
  },
);

// --- review tool ---

server.tool(
  "review",
  "Repo-aware code review. Default (agentic): Codex explores the repo in full-auto mode with built-in tools for deep context. Use quick: true for fast diff-only review.",
  {
    uncommitted: z
      .boolean()
      .optional()
      .describe("Review uncommitted changes (staged + unstaged). Default: true"),
    base: z
      .string()
      .optional()
      .describe("Base branch/ref to diff against (e.g. 'main'). Overrides uncommitted."),
    focus: z
      .string()
      .optional()
      .describe("Optional focus area (e.g. 'security', 'performance', 'error handling')"),
    quick: z
      .boolean()
      .optional()
      .describe("Skip repo exploration, just review the diff text. Default: false"),
    model: z.string().optional().describe("Model to use (e.g. o3, gpt-4.1)"),
    workingDirectory: z
      .string()
      .optional()
      .describe("Repository directory (auto-resolves to git root)"),
    timeout: z
      .number()
      .optional()
      .describe("Timeout in milliseconds (default: 300000 agentic / 120000 quick, max: 600000)"),
    maxResponseLength: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Soft limit on response length in words"),
  },
  async (input) => {
    try {
      const result = await executeReview(input);
      const meta: string[] = [
        `Diff source: ${result.diffSource}`,
        `Mode: ${result.mode}`,
      ];
      if (result.base) meta.push(`Base: ${result.base}`);
      if (result.fallbackUsed) meta.push("Note: fallback model used after quota exhaustion");
      if (result.timedOut) meta.push("(timed out)");

      return {
        content: [{
          type: "text",
          text: `${result.response}\n\n---\n${meta.join("\n")}`,
        }],
      };
    } catch (e) {
      return {
        content: [{ type: "text", text: `Error: ${(e as Error).message}` }],
        isError: true,
      };
    }
  },
);

// --- search tool ---

server.tool(
  "search",
  "Web search via Codex CLI. Searches the web and synthesizes an answer with source URLs.",
  {
    query: z.string().describe("Search query or question"),
    model: z.string().optional().describe("Model to use (e.g. o3, gpt-4.1)"),
    workingDirectory: z
      .string()
      .optional()
      .describe("Working directory for the CLI"),
    timeout: z
      .number()
      .optional()
      .describe("Timeout in milliseconds (default: 120000, max: 600000)"),
    maxResponseLength: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Soft limit on response length in words"),
  },
  async (input) => {
    try {
      const result = await executeSearch(input);
      const meta: string[] = [];
      if (result.timedOut) meta.push("(timed out)");
      if (result.fallbackUsed) {
        meta.push(`Note: ${result.model ?? "fallback model"} used after quota exhaustion`);
      } else if (result.model) {
        meta.push(`Model: ${result.model}`);
      }

      const text = meta.length > 0
        ? `${result.response}\n\n---\n${meta.join("\n")}`
        : result.response;

      return { content: [{ type: "text", text }] };
    } catch (e) {
      return {
        content: [{ type: "text", text: `Error: ${(e as Error).message}` }],
        isError: true,
      };
    }
  },
);

// --- structured tool ---

server.tool(
  "structured",
  "Generate a JSON response conforming to a provided JSON Schema. Use for data extraction, classification, or any task needing machine-parseable output.",
  {
    prompt: z.string().describe("What to generate or extract"),
    schema: z
      .string()
      .describe("JSON Schema the response must conform to (as a JSON string)"),
    files: z
      .array(z.string())
      .optional()
      .describe("File paths to include as context (text only, no images)"),
    model: z
      .string()
      .optional()
      .describe("Model to use (e.g. o3, gpt-4.1)"),
    workingDirectory: z
      .string()
      .optional()
      .describe("Working directory for file paths"),
    timeout: z
      .number()
      .optional()
      .describe("Timeout in milliseconds (default: 60000)"),
  },
  async (input) => {
    try {
      const result = await executeStructured(input);
      const meta: string[] = [];
      if (result.errors) meta.push(`Errors: ${result.errors}`);
      if (result.filesIncluded.length > 0) {
        meta.push(`Files: ${result.filesIncluded.join(", ")}`);
      }
      if (result.timedOut) meta.push("(timed out)");
      if (result.fallbackUsed) {
        meta.push(`Note: ${result.model ?? "fallback model"} used after quota exhaustion`);
      } else if (result.model) {
        meta.push(`Model: ${result.model}`);
      }

      const metaSuffix = meta.length > 0 ? `\n\n---\n${meta.join("\n")}` : "";

      return {
        content: [{
          type: "text",
          text: result.valid
            ? `${result.response}${metaSuffix}`
            : `${result.response}\n\n---\nSchema validation failed. ${meta.join("\n")}`,
        }],
        isError: !result.valid,
      };
    } catch (e) {
      return {
        content: [{ type: "text", text: `Error: ${(e as Error).message}` }],
        isError: true,
      };
    }
  },
);

// --- ping tool ---

server.tool(
  "ping",
  "Health check: verifies Codex CLI is installed and authenticated, reports versions and capabilities.",
  {},
  async () => {
    try {
      const result = await executePing();

      const lines = [
        `CLI found: ${result.cliFound ? "yes" : "NO — install with: npm i -g @openai/codex"}`,
        `CLI version: ${result.version ?? "unknown"}`,
        `Auth status: ${result.authStatus}`,
        `Default model: ${result.defaultModel ?? "(CLI default)"}`,
        `Fallback model: ${result.fallbackModel ?? "disabled"}`,
        `Server version: ${result.serverVersion}`,
        `Node version: ${result.nodeVersion}`,
        `Max concurrent: ${result.maxConcurrent}`,
      ];

      return {
        content: [{ type: "text", text: lines.join("\n") }],
      };
    } catch (e) {
      return {
        content: [{ type: "text", text: `Error: ${(e as Error).message}` }],
        isError: true,
      };
    }
  },
);

// --- Start server ---

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
