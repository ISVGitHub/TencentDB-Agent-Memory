#!/usr/bin/env node
/**
 * MCP Server for TencentDB Agent Memory.
 *
 * Exposes memory and skill tools via MCP (Model Context Protocol) stdio transport.
 * Compatible with Claude Code, OpenCode, and any MCP client.
 *
 * Usage:
 *   node --import tsx scripts/mcp-server.ts
 *   # or via npx:
 *   npx memory-tencentdb-mcp
 *
 * Environment:
 *   TDAI_GATEWAY_URL    - MemoryCore gateway URL (default: http://127.0.0.1:8420)
 *   TDAI_GATEWAY_API_KEY - Bearer token for gateway auth
 *   TDAI_SERVICE_ID     - x-tdai-service-id header (default: default)
 */

import http from "node:http";
import { getEnv } from "../src/utils/env.js";

const TAG = "[tdai-mcp]";

// ── Configuration ──

const GATEWAY_URL = getEnv("TDAI_GATEWAY_URL") ?? "http://127.0.0.1:8420";
const API_KEY = getEnv("TDAI_GATEWAY_API_KEY") ?? "";
const SERVICE_ID = getEnv("TDAI_SERVICE_ID") ?? "default";

// ── JSON-RPC 2.0 Types ──

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

interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
}

// ── Gateway HTTP Client ──

function gatewayRequest<T = unknown>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, GATEWAY_URL);
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "x-tdai-service-id": SERVICE_ID,
    };
    if (API_KEY) {
      headers["Authorization"] = `Bearer ${API_KEY}`;
    }

    const bodyStr = body ? JSON.stringify(body) : undefined;
    if (bodyStr) {
      headers["Content-Length"] = Buffer.byteLength(bodyStr).toString();
    }

    const req = http.request(url, { method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf-8");
        try {
          const parsed = JSON.parse(raw) as { code?: number; message?: string; data?: T };
          if (parsed.code && parsed.code !== 0) {
            reject(new Error(`Gateway error ${parsed.code}: ${parsed.message}`));
          } else {
            resolve(parsed.data ?? (parsed as T));
          }
        } catch {
          reject(new Error(`Invalid JSON from gateway: ${raw.slice(0, 200)}`));
        }
      });
    });

    req.on("error", reject);
    req.setTimeout(30_000, () => {
      req.destroy();
      reject(new Error("Gateway request timeout (30s)"));
    });

    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// ── Tool Definitions ──

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<string>;
}

const tools: ToolDef[] = [
  {
    name: "memory_search",
    description: "Search L1 atomic memories (facts, preferences, constraints). Returns relevant memories matching the query.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
        agent_id: { type: "string", description: "Agent ID (optional, filters by agent)" },
        team_id: { type: "string", description: "Team ID (optional, filters by team)" },
        user_id: { type: "string", description: "User ID (optional, filters by user)" },
        max_results: { type: "number", description: "Max results (default: 10)" },
      },
      required: ["query"],
    },
    handler: async (args) => {
      const body: Record<string, unknown> = {
        query: args.query,
        max_results: args.max_results ?? 10,
      };
      if (args.agent_id) body.agent_id = args.agent_id;
      if (args.team_id) body.team_id = args.team_id;
      if (args.user_id) body.user_id = args.user_id;

      const result = await gatewayRequest("POST", "/v3/atomic/search", body);
      return JSON.stringify(result, null, 2);
    },
  },
  {
    name: "memory_write",
    description: "Write conversation messages to L0 memory. Messages are later distilled into L1 atoms by the pipeline.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string", description: "Session ID" },
        messages: {
          type: "array",
          items: {
            type: "object",
            properties: {
              role: { type: "string", enum: ["user", "assistant", "system"] },
              content: { type: "string" },
            },
            required: ["role", "content"],
          },
          description: "Messages to write",
        },
        agent_id: { type: "string", description: "Agent ID" },
        team_id: { type: "string", description: "Team ID" },
        user_id: { type: "string", description: "User ID" },
      },
      required: ["session_id", "messages"],
    },
    handler: async (args) => {
      const body: Record<string, unknown> = {
        session_id: args.session_id,
        messages: args.messages,
      };
      if (args.agent_id) body.agent_id = args.agent_id;
      if (args.team_id) body.team_id = args.team_id;
      if (args.user_id) body.user_id = args.user_id;

      const result = await gatewayRequest("POST", "/v3/conversation/add", body);
      return JSON.stringify(result, null, 2);
    },
  },
  {
    name: "skill_search",
    description: "Search available skills by name or description. Returns skill metadata and content.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
        agent_id: { type: "string", description: "Agent ID (filters by owner)" },
        team_id: { type: "string", description: "Team ID (filters by team)" },
        max_results: { type: "number", description: "Max results (default: 10)" },
      },
      required: ["query"],
    },
    handler: async (args) => {
      const body: Record<string, unknown> = {
        query: args.query,
        max_results: args.max_results ?? 10,
      };
      if (args.agent_id) body.agent_id = args.agent_id;
      if (args.team_id) body.team_id = args.team_id;

      const result = await gatewayRequest("POST", "/v3/skill/search", body);
      return JSON.stringify(result, null, 2);
    },
  },
  {
    name: "skill_get",
    description: "Get a specific skill by ID, including its full content and resources.",
    inputSchema: {
      type: "object",
      properties: {
        skill_id: { type: "string", description: "Skill ID" },
      },
      required: ["skill_id"],
    },
    handler: async (args) => {
      const result = await gatewayRequest("POST", "/v3/skill/get", {
        skill_id: args.skill_id,
      });
      return JSON.stringify(result, null, 2);
    },
  },
  {
    name: "skill_list",
    description: "List available skills with optional filters.",
    inputSchema: {
      type: "object",
      properties: {
        team_id: { type: "string", description: "Team ID filter" },
        agent_id: { type: "string", description: "Agent ID filter" },
        status: { type: "string", enum: ["active", "archived"], description: "Status filter" },
        limit: { type: "number", description: "Max results (default: 20)" },
      },
    },
    handler: async (args) => {
      const body: Record<string, unknown> = {
        limit: args.limit ?? 20,
      };
      if (args.team_id) body.team_id = args.team_id;
      if (args.agent_id) body.agent_id = args.agent_id;
      if (args.status) body.status = args.status;

      const result = await gatewayRequest("POST", "/v3/skill/list", body);
      return JSON.stringify(result, null, 2);
    },
  },
  {
    name: "conversation_search",
    description: "Search L0 raw conversations. Useful for finding exact wording or historical context.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
        agent_id: { type: "string", description: "Agent ID filter" },
        team_id: { type: "string", description: "Team ID filter" },
        user_id: { type: "string", description: "User ID filter" },
        max_results: { type: "number", description: "Max results (default: 10)" },
      },
      required: ["query"],
    },
    handler: async (args) => {
      const body: Record<string, unknown> = {
        query: args.query,
        max_results: args.max_results ?? 10,
      };
      if (args.agent_id) body.agent_id = args.agent_id;
      if (args.team_id) body.team_id = args.team_id;
      if (args.user_id) body.user_id = args.user_id;

      const result = await gatewayRequest("POST", "/v3/conversation/search", body);
      return JSON.stringify(result, null, 2);
    },
  },
  {
    name: "persona_read",
    description: "Read the L3 persona/profile for a user or team. Returns the long-term user profile.",
    inputSchema: {
      type: "object",
      properties: {
        agent_id: { type: "string", description: "Agent ID" },
        team_id: { type: "string", description: "Team ID" },
        user_id: { type: "string", description: "User ID" },
      },
    },
    handler: async (args) => {
      const body: Record<string, unknown> = {};
      if (args.agent_id) body.agent_id = args.agent_id;
      if (args.team_id) body.team_id = args.team_id;
      if (args.user_id) body.user_id = args.user_id;

      const result = await gatewayRequest("POST", "/v3/core/read", body);
      return JSON.stringify(result, null, 2);
    },
  },
  {
    name: "scenario_list",
    description: "List L2 scenario blocks. Scenarios are knowledge blocks organized by project or topic.",
    inputSchema: {
      type: "object",
      properties: {
        agent_id: { type: "string", description: "Agent ID" },
        team_id: { type: "string", description: "Team ID" },
        user_id: { type: "string", description: "User ID" },
      },
    },
    handler: async (args) => {
      const body: Record<string, unknown> = {};
      if (args.agent_id) body.agent_id = args.agent_id;
      if (args.team_id) body.team_id = args.team_id;
      if (args.user_id) body.user_id = args.user_id;

      const result = await gatewayRequest("POST", "/v3/scenario/ls", body);
      return JSON.stringify(result, null, 2);
    },
  },
];

// ── MCP Protocol Handler ──

function handleRequest(req: JsonRpcRequest): JsonRpcResponse {
  switch (req.method) {
    case "initialize":
      return {
        jsonrpc: "2.0",
        id: req.id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: {
            name: "tencentdb-agent-memory",
            version: "2.0.0",
          },
        },
      };

    case "tools/list":
      return {
        jsonrpc: "2.0",
        id: req.id,
        result: {
          tools: tools.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
          })),
        },
      };

    case "tools/call": {
      const params = req.params as { name?: string; arguments?: Record<string, unknown> };
      const toolName = params?.name;
      const toolArgs = params?.arguments ?? {};

      if (!toolName) {
        return {
          jsonrpc: "2.0",
          id: req.id,
          error: { code: -32602, message: "Missing tool name" },
        };
      }

      const tool = tools.find((t) => t.name === toolName);
      if (!tool) {
        return {
          jsonrpc: "2.0",
          id: req.id,
          error: { code: -32602, message: `Unknown tool: ${toolName}` },
        };
      }

      // Execute async, return via callback
      tool.handler(toolArgs)
        .then((result) => {
          const response: JsonRpcResponse = {
            jsonrpc: "2.0",
            id: req.id,
            result: {
              content: [{ type: "text", text: result }],
            },
          };
          sendResponse(response);
        })
        .catch((err) => {
          const response: JsonRpcResponse = {
            jsonrpc: "2.0",
            id: req.id,
            result: {
              content: [{
                type: "text",
                text: `Error: ${err instanceof Error ? err.message : String(err)}`,
              }],
              isError: true,
            },
          };
          sendResponse(response);
        });

      // Return null to indicate async handling
      return null as unknown as JsonRpcResponse;
    }

    default:
      return {
        jsonrpc: "2.0",
        id: req.id,
        error: { code: -32601, message: `Method not found: ${req.method}` },
      };
  }
}

// ── Stdio Transport ──

let buffer = "";

function sendResponse(response: JsonRpcResponse): void {
  const json = JSON.stringify(response);
  const message = `Content-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}`;
  process.stdout.write(message);
}

function processMessage(data: string): void {
  try {
    const request = JSON.parse(data) as JsonRpcRequest | JsonRpcNotification;

    if (!("id" in request)) {
      // Notification — no response needed
      if (request.method === "notifications/initialized") {
        // Client confirmed initialization
      }
      return;
    }

    const response = handleRequest(request);
    if (response) {
      sendResponse(response);
    }
  } catch (err) {
    console.error(`${TAG} Error processing message:`, err);
  }
}

function processBuffer(): void {
  while (true) {
    const headerEnd = buffer.indexOf("\r\n\r\n");
    if (headerEnd === -1) break;

    const header = buffer.slice(0, headerEnd);
    const contentLengthMatch = header.match(/Content-Length:\s*(\d+)/i);
    if (!contentLengthMatch) {
      // Try newline-delimited JSON (simpler format)
      const newlineIdx = buffer.indexOf("\n");
      if (newlineIdx === -1) break;
      const line = buffer.slice(0, newlineIdx).trim();
      buffer = buffer.slice(newlineIdx + 1);
      if (line) processMessage(line);
      continue;
    }

    const contentLength = parseInt(contentLengthMatch[1]!, 10);
    const bodyStart = headerEnd + 4;
    if (buffer.length < bodyStart + contentLength) break; // Incomplete

    const body = buffer.slice(bodyStart, bodyStart + contentLength);
    buffer = buffer.slice(bodyStart + contentLength);
    processMessage(body);
  }
}

// ── Main ──

function main(): void {
  console.error(`${TAG} Starting MCP server (gateway: ${GATEWAY_URL})`);

  process.stdin.setEncoding("utf-8");
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    processBuffer();
  });

  process.stdin.on("end", () => {
    console.error(`${TAG} stdin closed, shutting down`);
    process.exit(0);
  });

  process.on("SIGINT", () => {
    console.error(`${TAG} SIGINT received, shutting down`);
    process.exit(0);
  });

  process.on("SIGTERM", () => {
    console.error(`${TAG} SIGTERM received, shutting down`);
    process.exit(0);
  });
}

main();
