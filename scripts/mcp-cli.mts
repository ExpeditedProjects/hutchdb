// Minimal MCP CLI for Hutch Core.
//
//   npx tsx scripts/mcp-cli.mts list
//   npx tsx scripts/mcp-cli.mts call <tool> '<json args>'
//   npx tsx scripts/mcp-cli.mts call <tool> @args.json
//
// Env: MCP_URL (default http://localhost:3112/api/mcp), MCP_API_KEY (optional bearer).
// JSON-RPC / SSE handling adapted from scripts/smoke.ts.

import { readFileSync } from "node:fs";

const MCP_URL = process.env.MCP_URL ?? "http://localhost:3112/api/mcp";
const API_KEY = process.env.MCP_API_KEY;

const USAGE = `usage:
  mcp-cli.mts list
  mcp-cli.mts call <tool> ['<json args>' | @file.json]

env: MCP_URL (default http://localhost:3112/api/mcp), MCP_API_KEY`;

type JsonRpcMessage = {
  jsonrpc: string;
  id?: number | string | null;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
};

type ToolCallResult = { content?: { type: string; text?: string }[]; isError?: boolean };

type ToolInfo = { name: string; description?: string };

function usageExit(message?: string): never {
  if (message) console.error(`mcp-cli: ${message}\n`);
  console.error(USAGE);
  process.exit(2);
}

// The server may answer as plain JSON or as an SSE body with `data:` lines;
// for SSE the response to our request is the message carrying an id.
async function readJsonRpcResponse(res: Response): Promise<JsonRpcMessage> {
  const contentType = res.headers.get("content-type") ?? "";
  const text = await res.text();

  if (contentType.includes("text/event-stream")) {
    for (const line of text.split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue;
      try {
        const msg = JSON.parse(line.slice(5).trim()) as JsonRpcMessage;
        if (msg.id !== undefined && msg.id !== null) return msg;
      } catch {
        // Non-JSON data line (keepalive etc.) -- skip.
      }
    }
    throw new Error(`SSE response contained no JSON-RPC message: ${text.slice(0, 200)}`);
  }

  return JSON.parse(text) as JsonRpcMessage;
}

let rpcId = 0;

async function rpc(method: string, params?: Record<string, unknown>, label = method): Promise<Record<string, unknown>> {
  const started = performance.now();
  const res = await fetch(MCP_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(API_KEY ? { Authorization: `Bearer ${API_KEY}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, ...(params ? { params } : {}) }),
  });
  if (res.status >= 400) {
    throw new Error(`${method}: HTTP ${res.status}`);
  }
  const msg = await readJsonRpcResponse(res);
  console.error(`[mcp-cli] ${label} ${(performance.now() - started).toFixed(1)}ms`);
  if (msg.error) {
    throw new Error(`${method}: JSON-RPC error ${msg.error.code}: ${msg.error.message}`);
  }
  if (!msg.result) {
    throw new Error(`${method}: response had no result`);
  }
  return msg.result;
}

async function initialize(): Promise<void> {
  await rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "hutch-mcp-cli", version: "1.0.0" },
  });
}

async function listTools(): Promise<void> {
  await initialize();
  const listed = await rpc("tools/list");
  const tools = (listed.tools ?? []) as ToolInfo[];
  for (const tool of tools) {
    const description = (tool.description ?? "").trim();
    console.log(tool.name);
    if (description) console.log(description.replace(/^/gm, "  "));
    console.log();
  }
}

function parseArgs(raw: string | undefined): Record<string, unknown> {
  if (raw === undefined) return {};
  const source = raw.startsWith("@") ? readFileSync(raw.slice(1), "utf8") : raw;
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (err) {
    usageExit(`invalid JSON args: ${(err as Error).message}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    usageExit("args must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

async function callTool(name: string, args: Record<string, unknown>): Promise<void> {
  await initialize();
  const result = (await rpc("tools/call", { name, arguments: args }, `tools/call ${name}`)) as ToolCallResult;
  const text = result.content?.find((c) => c.type === "text")?.text ?? "";
  if (result.isError) {
    console.error(text);
    process.exit(1);
  }
  console.log(text);
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  switch (command) {
    case "list":
      if (rest.length > 0) usageExit("list takes no arguments");
      return listTools();
    case "call": {
      const [tool, raw, ...extra] = rest;
      if (!tool || extra.length > 0) usageExit("call requires <tool> and at most one args value");
      return callTool(tool, parseArgs(raw));
    }
    default:
      usageExit(command ? `unknown command "${command}"` : undefined);
  }
}

main().catch((err: unknown) => {
  console.error(`mcp-cli: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
