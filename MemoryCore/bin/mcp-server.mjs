#!/usr/bin/env node
/**
 * MCP server entry point for TencentDB Agent Memory.
 *
 * Usage:
 *   node bin/mcp-server.mjs
 *
 * Environment variables:
 *   TDAI_GATEWAY_URL    — Gateway URL (default: http://127.0.0.1:8420)
 *   TDAI_GATEWAY_API_KEY — Bearer token for auth
 *   TDAI_SERVICE_ID     — Service instance ID (default: default)
 *   TDAI_TEAM_ID        — Team ID (default: default)
 *   TDAI_AGENT_ID       — Agent ID (default: default)
 *   TDAI_USER_ID        — User ID (default: default)
 */

import "../src/mcp/server.js";
