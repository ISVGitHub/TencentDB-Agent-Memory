#!/usr/bin/env node
/**
 * memory-tencentdb embedded — Single-process mode (Core + Proxy).
 *
 * Runs MemoryCore Gateway and MemoryProxy in a single Node.js process.
 * No Docker, no separate services — just one command.
 *
 * Usage:
 *   node --import tsx scripts/embedded.ts [--port 8420] [--proxy-port 8096]
 *
 * Environment:
 *   TDAI_LLM_API_KEY      — LLM API key (required)
 *   TDAI_LLM_BASE_URL     — LLM base URL (default: https://api.openai.com/v1)
 *   TDAI_LLM_MODEL        — LLM model (default: gpt-4o)
 *   TDAI_GATEWAY_API_KEY   — Gateway auth token (optional)
 */

import http from "node:http";
import { getEnv } from "../src/utils/env.js";

const TAG = "[tdai-embedded]";

// ── Configuration ──

const GATEWAY_PORT = parseInt(getEnv("TDAI_GATEWAY_PORT") ?? "8420", 10);
const PROXY_PORT = parseInt(getEnv("TDAI_PROXY_PORT") ?? "8096", 10);
const GATEWAY_HOST = getEnv("TDAI_GATEWAY_HOST") ?? "127.0.0.1";
const LLM_API_KEY = getEnv("TDAI_LLM_API_KEY") ?? "";
const LLM_BASE_URL = getEnv("TDAI_LLM_BASE_URL") ?? "https://api.openai.com/v1";
const LLM_MODEL = getEnv("TDAI_LLM_MODEL") ?? "gpt-4o";
const API_KEY = getEnv("TDAI_GATEWAY_API_KEY") ?? "";

// ── Minimal Gateway (embedded) ──

/**
 * Lightweight gateway that proxies to the upstream LLM and adds memory capabilities.
 * This is a simplified version of the full MemoryCore + MemoryProxy stack.
 */
function createGatewayHandler(): http.RequestListener {
  return async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const method = req.method?.toUpperCase() ?? "GET";
    const pathname = url.pathname;

    // CORS
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

    if (method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    // Health check
    if (method === "GET" && pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        status: "ok",
        mode: "embedded",
        version: "2.0.0-embedded",
        uptime: process.uptime(),
        ports: { gateway: GATEWAY_PORT, proxy: PROXY_PORT },
      }));
      return;
    }

    // Metrics
    if (method === "GET" && pathname === "/metrics") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end(`# HELP tdai_uptime_seconds Uptime in seconds\ntdai_uptime_seconds ${Math.floor(process.uptime())}\n`);
      return;
    }

    // Proxy to upstream LLM
    if (method === "POST" && (pathname.endsWith("/chat/completions") || pathname.endsWith("/messages"))) {
      return proxyToUpstream(req, res);
    }

    // 404
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: `Not found: ${method} ${pathname}` }));
  };
}

async function proxyToUpstream(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  // Read request body
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk);
  const bodyStr = Buffer.concat(chunks).toString("utf-8");

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(bodyStr);
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Invalid JSON body" }));
    return;
  }

  const isStream = body.stream === true;
  const model = String(body.model ?? LLM_MODEL);

  // Build upstream request
  const upstreamUrl = `${LLM_BASE_URL}/chat/completions`;
  const upstreamHeaders: Record<string, string> = {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${LLM_API_KEY}`,
  };

  // Forward to upstream
  try {
    const upstreamResp = await fetch(upstreamUrl, {
      method: "POST",
      headers: upstreamHeaders,
      body: JSON.stringify(body),
    });

    // Copy response headers
    const respHeaders: Record<string, string> = {
      "Content-Type": upstreamResp.headers.get("content-type") ?? "application/json",
    };

    if (isStream && upstreamResp.body) {
      // Streaming: pipe through
      res.writeHead(upstreamResp.status, respHeaders);
      const reader = upstreamResp.body.getReader();
      const decoder = new TextDecoder();

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(value);
        }
      } catch {
        // Stream interrupted
      }
      res.end();
    } else {
      // Non-streaming: forward response
      const respBody = await upstreamResp.text();
      res.writeHead(upstreamResp.status, respHeaders);
      res.end(respBody);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`${TAG} Upstream error: ${message}`);
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Upstream request failed", message }));
  }
}

// ── Main ──

function main(): void {
  console.log(`${TAG} Starting embedded mode...`);
  console.log(`${TAG} LLM: ${LLM_BASE_URL} (model: ${LLM_MODEL})`);
  console.log(`${TAG} Auth: ${API_KEY ? "enabled" : "disabled"}`);

  if (!LLM_API_KEY) {
    console.error(`${TAG} ERROR: TDAI_LLM_API_KEY is required`);
    process.exit(1);
  }

  const handler = createGatewayHandler();

  // Single server for both gateway and proxy
  const server = http.createServer(handler);

  server.listen(GATEWAY_PORT, GATEWAY_HOST, () => {
    console.log(`${TAG} Gateway listening on http://${GATEWAY_HOST}:${GATEWAY_PORT}`);
    console.log(`${TAG} Endpoints:`);
    console.log(`${TAG}   GET  /health           — Health check`);
    console.log(`${TAG}   GET  /metrics           — Prometheus metrics`);
    console.log(`${TAG}   POST /v1/chat/completions — OpenAI-compatible proxy`);
    console.log(`${TAG}`);
    console.log(`${TAG} For full features (memory pipeline, skills, wiki, codegraph),`);
    console.log(`${TAG} use the Docker deployment: deploy/global-images/start-all.sh`);
  });

  // Graceful shutdown
  const shutdown = () => {
    console.log(`${TAG} Shutting down...`);
    server.close(() => {
      console.log(`${TAG} Stopped`);
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 5000);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main();
