/**
 * MCP Server for TencentDB Agent Memory.
 *
 * Exposes MemoryCore capabilities as MCP tools for Claude Code, OpenCode,
 * and any MCP-compatible agent. Communicates with MemoryCore Gateway (:8420)
 * over HTTP using the TypeScript SDK.
 *
 * Transport: stdio (for Claude Code / local agents)
 *           SSE  (for web-based agents, optional)
 *
 * Tools exposed:
 *   memory_search   — Search L1 memories (BM25 + vector + RRF)
 *   memory_write    — Write L0 conversation messages
 *   skill_search    — Search skills by query
 *   skill_call      — Read a skill by ID
 *   wiki_read       — Read a wiki page
 *   codegraph_impact — Analyze code impact paths
 */

import { createInterface } from "node:readline";

// ============================
// Types
// ============================

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

interface McpToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

// ============================
// Config
// ============================

interface McpServerConfig {
  gatewayUrl: string;
  apiKey?: string;
  serviceId: string;
  teamId: string;
  agentId: string;
  userId: string;
}

function loadConfig(): McpServerConfig {
  return {
    gatewayUrl: process.env.TDAI_GATEWAY_URL || "http://127.0.0.1:8420",
    apiKey: process.env.TDAI_GATEWAY_API_KEY,
    serviceId: process.env.TDAI_SERVICE_ID || "default",
    teamId: process.env.TDAI_TEAM_ID || "default",
    agentId: process.env.TDAI_AGENT_ID || "default",
    userId: process.env.TDAI_USER_ID || "default",
  };
}

// ============================
// HTTP client
// ============================

async function gatewayRequest(
  config: McpServerConfig,
  path: string,
  body: Record<string, unknown>,
): Promise<unknown> {
  const url = `${config.gatewayUrl}${path}`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-tdai-service-id": config.serviceId,
    "x-tdai-team-id": config.teamId,
    "x-tdai-agent-id": config.agentId,
    "x-tdai-user-id": config.userId,
  };
  if (config.apiKey) {
    headers["Authorization"] = `Bearer ${config.apiKey}`;
  }

  const resp = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Gateway ${resp.status}: ${text}`);
  }

  const data = (await resp.json()) as { code?: number; message?: string; data?: unknown };
  if (data.code && data.code !== 0) {
    throw new Error(`Gateway error ${data.code}: ${data.message}`);
  }
  return data.data;
}

// ============================
// Tool definitions
// ============================

const TOOLS: ToolDefinition[] = [
  {
    name: "memory_search",
    description: "Search L1 atomic memories by semantic query. Returns structured facts, preferences, and decisions extracted from conversations.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query text" },
        max_results: { type: "number", description: "Max results to return (default: 5)" },
        session_id: { type: "string", description: "Optional: scope to specific session" },
      },
      required: ["query"],
    },
  },
  {
    name: "memory_write",
    description: "Write conversation messages to L0 memory store. Triggers async L1 extraction pipeline.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string", description: "Session identifier" },
        messages: {
          type: "array",
          description: "Array of {role, content} message objects",
          items: {
            type: "object",
            properties: {
              role: { type: "string", enum: ["user", "assistant", "system"] },
              content: { type: "string" },
            },
            required: ["role", "content"],
          },
        },
      },
      required: ["session_id", "messages"],
    },
  },
  {
    name: "skill_search",
    description: "Search available skills by query. Returns skill names, descriptions, and IDs.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query for skills" },
        top_k: { type: "number", description: "Max skills to return (default: 10)" },
      },
      required: ["query"],
    },
  },
  {
    name: "skill_read",
    description: "Read a skill's full content (SKILL.md + resources) by ID.",
    inputSchema: {
      type: "object",
      properties: {
        skill_id: { type: "string", description: "Skill ID to read" },
      },
      required: ["skill_id"],
    },
  },
  {
    name: "conversation_search",
    description: "Search L0 raw conversation history by keyword or semantic query.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
        session_id: { type: "string", description: "Optional: scope to session" },
        max_results: { type: "number", description: "Max results (default: 10)" },
      },
      required: ["query"],
    },
  },
  {
    name: "persona_read",
    description: "Read the L3 persona profile — long-term user patterns and preferences.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "scenario_list",
    description: "List L2 scenario blocks — knowledge organized by project/topic.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "scenario_read",
    description: "Read a specific L2 scenario block by name.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Scenario name" },
      },
      required: ["name"],
    },
  },
];

// ============================
// Tool handlers
// ============================

async function handleToolCall(
  config: McpServerConfig,
  name: string,
  args: Record<string, unknown>,
): Promise<McpToolResult> {
  try {
    let result: unknown;

    switch (name) {
      case "memory_search": {
        result = await gatewayRequest(config, "/v3/atomic/search", {
          query: args.query,
          max_results: args.max_results ?? 5,
          ...(args.session_id ? { session_id: args.session_id } : {}),
        });
        break;
      }

      case "memory_write": {
        result = await gatewayRequest(config, "/v3/conversation/add", {
          session_id: args.session_id,
          messages: args.messages,
        });
        break;
      }

      case "skill_search": {
        result = await gatewayRequest(config, "/v3/skill/search", {
          query: args.query,
          top_k: args.top_k ?? 10,
        });
        break;
      }

      case "skill_read": {
        result = await gatewayRequest(config, "/v3/skill/get", {
          skill_id: args.skill_id,
        });
        break;
      }

      case "conversation_search": {
        result = await gatewayRequest(config, "/v3/conversation/search", {
          query: args.query,
          max_results: args.max_results ?? 10,
          ...(args.session_id ? { session_id: args.session_id } : {}),
        });
        break;
      }

      case "persona_read": {
        result = await gatewayRequest(config, "/v3/core/read", {});
        break;
      }

      case "scenario_list": {
        result = await gatewayRequest(config, "/v3/scenario/ls", {});
        break;
      }

      case "scenario_read": {
        result = await gatewayRequest(config, "/v3/scenario/read", {
          name: args.name,
        });
        break;
      }

      default:
        return {
          content: [{ type: "text", text: `Unknown tool: ${name}` }],
          isError: true,
        };
    }

    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: "text", text: `Error: ${message}` }],
      isError: true,
    };
  }
}

// ============================
// MCP protocol handler
// ============================

function createResponse(id: number | string, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

function createError(id: number | string, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

async function handleRequest(
  config: McpServerConfig,
  req: JsonRpcRequest,
): Promise<JsonRpcResponse> {
  switch (req.method) {
    case "initialize":
      return createResponse(req.id, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: {
          name: "tencentdb-agent-memory",
          version: "2.0.0",
        },
      });

    case "notifications/initialized":
      // No response needed for notifications
      return createResponse(req.id, {});

    case "tools/list":
      return createResponse(req.id, { tools: TOOLS });

    case "tools/call": {
      const params = req.params as { name?: string; arguments?: Record<string, unknown> } | undefined;
      if (!params?.name) {
        return createError(req.id, -32602, "Missing tool name");
      }
      const result = await handleToolCall(config, params.name, params.arguments ?? {});
      return createResponse(req.id, result);
    }

    case "ping":
      return createResponse(req.id, {});

    default:
      return createError(req.id, -32601, `Method not found: ${req.method}`);
  }
}

// ============================
// Stdio transport
// ============================

async function runStdio(config: McpServerConfig): Promise<void> {
  const rl = createInterface({ input: process.stdin });

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let req: JsonRpcRequest;
    try {
      req = JSON.parse(trimmed) as JsonRpcRequest;
    } catch {
      const errResp = createError(0, -32700, "Parse error");
      process.stdout.write(JSON.stringify(errResp) + "\n");
      continue;
    }

    // Notifications (no id) don't get responses
    if (req.id === undefined || req.id === null) {
      continue;
    }

    const resp = await handleRequest(config, req);
    process.stdout.write(JSON.stringify(resp) + "\n");
  }
}

// ============================
// Main
// ============================

async function main(): Promise<void> {
  const config = loadConfig();

  // Health check
  try {
    const resp = await fetch(`${config.gatewayUrl}/health`);
    if (!resp.ok) {
      process.stderr.write(`[mcp] Warning: Gateway health check failed (${resp.status})\n`);
    }
  } catch (err) {
    process.stderr.write(
      `[mcp] Warning: Cannot reach gateway at ${config.gatewayUrl}: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }

  process.stderr.write(`[mcp] TencentDB Agent Memory MCP Server started\n`);
  process.stderr.write(`[mcp] Gateway: ${config.gatewayUrl}\n`);
  process.stderr.write(`[mcp] Tools: ${TOOLS.map((t) => t.name).join(", ")}\n`);

  await runStdio(config);
}

main().catch((err) => {
  process.stderr.write(`[mcp] Fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
