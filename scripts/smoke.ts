// Smoke test for Hutch Core.
//
// Runs against a running Core instance (default http://localhost:3000; override
// with SMOKE_BASE_URL). The contract:
//
// - If SMOKE_API_KEY is set: POST /api/mcp with NO Authorization must return
//   401, and with `Authorization: Bearer <SMOKE_API_KEY>` must return a
//   non-401. We do not assert 200 — the transport may return 200 with a
//   JSON-RPC body or a 2xx SSE stream depending on the client's Accept
//   headers.
// - If SMOKE_API_KEY is not set: Core is in anonymous singleton mode. POST
//   /api/mcp with no Authorization must return a non-500 response.
// - In every case, 401 responses must NOT include a WWW-Authenticate header.
//   Core has no OAuth authorization server; the presence of that header would
//   suggest a stale build.
//
// Opt-in full loop (SMOKE_FULL=1): runs a real MCP session end to end —
// initialize → tools/list (18 tools, titles, readOnlyHint on read tools) →
// store → query (operator filter) → transform (rename) → export CSV →
// delete collection — against a scratch collection that is removed at the
// end. Requires the target server to have a working database.

const BASE_URL = (process.env.SMOKE_BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");
const API_KEY = process.env.SMOKE_API_KEY;
const SMOKE_FULL = process.env.SMOKE_FULL === "1";
const MCP_URL = `${BASE_URL}/api/mcp`;

const failures: string[] = [];

function check(condition: unknown, message: string) {
  if (!condition) failures.push(message);
}

function jsonRpcBody(): string {
  return JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 1 });
}

async function postMcp(headers: Record<string, string> = {}): Promise<Response> {
  return fetch(MCP_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...headers,
    },
    body: jsonRpcBody(),
  });
}

function assertNoWwwAuthenticate(res: Response, label: string) {
  const wwwAuth = res.headers.get("www-authenticate");
  check(
    wwwAuth === null,
    `${label}: unexpected WWW-Authenticate header "${wwwAuth}" (Core does not run an OAuth AS)`,
  );
}

async function checkKeyed() {
  const unauth = await postMcp();
  check(unauth.status === 401, `${MCP_URL} (no bearer): expected 401, got ${unauth.status}`);
  assertNoWwwAuthenticate(unauth, `${MCP_URL} (no bearer)`);

  const authed = await postMcp({ Authorization: `Bearer ${API_KEY}` });
  check(
    authed.status !== 401,
    `${MCP_URL} (Bearer ${API_KEY?.slice(0, 4)}...): expected non-401, got ${authed.status}`,
  );
}

async function checkAnonymous() {
  const res = await postMcp();
  check(
    res.status < 500,
    `${MCP_URL} (anon): expected non-500 response, got ${res.status}`,
  );
  if (res.status === 401) assertNoWwwAuthenticate(res, `${MCP_URL} (anon 401)`);
}

// ── SMOKE_FULL=1: full MCP tool-call loop ────────────────────────────────────

type JsonRpcMessage = {
  jsonrpc: string;
  id?: number | string | null;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
};

/**
 * Parse a JSON-RPC response body that may arrive either as plain JSON or as
 * an SSE stream (the streamable-HTTP transport picks per the Accept header —
 * postMcp advertises both). For SSE, the payload is in `data:` lines; the
 * response to our request is the event whose message carries an id.
 */
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
        // Non-JSON data line (keepalive etc.) — skip.
      }
    }
    throw new Error(`SSE response contained no JSON-RPC message: ${text.slice(0, 200)}`);
  }

  return JSON.parse(text) as JsonRpcMessage;
}

let rpcId = 0;

async function rpc(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>> {
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
  if (msg.error) {
    throw new Error(`${method}: JSON-RPC error ${msg.error.code}: ${msg.error.message}`);
  }
  if (!msg.result) {
    throw new Error(`${method}: response had no result`);
  }
  return msg.result;
}

type ToolCallResult = { content?: { type: string; text?: string }[]; isError?: boolean };

/** tools/call, returning the first text content block (usually JSON). */
async function callTool(name: string, args: Record<string, unknown>): Promise<string> {
  const result = (await rpc("tools/call", { name, arguments: args })) as ToolCallResult;
  const text = result.content?.find((c) => c.type === "text")?.text ?? "";
  if (result.isError) {
    throw new Error(`tools/call ${name}: tool error: ${text.slice(0, 300)}`);
  }
  return text;
}

/** Parse the JSON blob out of a tool response (some lead with a summary line). */
function toolJson(text: string): Record<string, unknown> {
  const start = text.search(/[[{]/);
  if (start === -1) throw new Error(`tool response had no JSON: ${text.slice(0, 200)}`);
  return JSON.parse(text.slice(start)) as Record<string, unknown>;
}

const EXPECTED_TOOL_COUNT = 18;

// Tools registered with readOnlyHint: true in src/lib/mcp/server.ts.
const READ_ONLY_TOOLS = [
  "hutch_list_collections",
  "hutch_get_collection",
  "hutch_describe_collection",
  "hutch_query_records",
  "hutch_search",
  "hutch_collection_stats",
  "hutch_export_records",
];

async function checkFull() {
  console.log("smoke: SMOKE_FULL=1 — running full MCP loop");

  // initialize
  const init = await rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "hutch-smoke", version: "1.0.0" },
  });
  check(typeof init.protocolVersion === "string", "initialize: missing protocolVersion in result");

  // tools/list — count, titles, read-only hints
  const listed = await rpc("tools/list");
  const tools = (listed.tools ?? []) as {
    name: string;
    title?: string;
    annotations?: { readOnlyHint?: boolean };
  }[];
  check(
    tools.length === EXPECTED_TOOL_COUNT,
    `tools/list: expected exactly ${EXPECTED_TOOL_COUNT} tools, got ${tools.length}`,
  );
  for (const tool of tools) {
    check(
      typeof tool.title === "string" && tool.title.length > 0,
      `tools/list: tool ${tool.name} has no title`,
    );
  }
  const byName = new Map(tools.map((t) => [t.name, t]));
  for (const name of READ_ONLY_TOOLS) {
    const tool = byName.get(name);
    check(tool !== undefined, `tools/list: read tool ${name} is missing`);
    check(
      tool?.annotations?.readOnlyHint === true,
      `tools/list: read tool ${name} lacks readOnlyHint: true`,
    );
  }

  // tools/call cycle against a scratch collection
  const collectionName = `smoke_full_${Date.now()}`;
  let slug: string | undefined;
  try {
    const stored = toolJson(
      await callTool("hutch_store_records", {
        collection: collectionName,
        records: [
          { item: "aa", n: 1 },
          { item: "bb", n: 2 },
          { item: "cc", n: 3 },
        ],
      }),
    );
    slug = (stored.collection as { slug?: string } | undefined)?.slug;
    check(typeof slug === "string" && slug.length > 0, "store_records: no collection slug in response");
    check(stored.count === 3, `store_records: expected count 3, got ${stored.count}`);
    if (!slug) return;

    const queried = toolJson(
      await callTool("hutch_query_records", { slug, filter: { n: { $gte: 2 } } }),
    );
    check(queried.total === 2, `query_records ($gte operator): expected total 2, got ${queried.total}`);

    const transformed = toolJson(
      await callTool("hutch_transform_records", { slug, rename_fields: { n: "num" } }),
    );
    check(transformed.updated === 3, `transform_records rename: expected 3 updated, got ${transformed.updated}`);

    const exported = toolJson(await callTool("hutch_export_records", { collection: slug, format: "csv" }));
    check(exported.format === "csv", `export_records: expected csv format, got ${exported.format}`);
    check(exported.count === 3, `export_records: expected count 3, got ${exported.count}`);
    const csv = typeof exported.content === "string" ? exported.content : "";
    const header = csv.split(/\r?\n/)[0].split(",");
    check(header.includes("num"), "export_records: CSV missing renamed column 'num'");
    check(!header.includes("n"), "export_records: CSV still has pre-rename column 'n'");
  } finally {
    // Always try to remove the scratch collection, even on assertion failure.
    if (slug) {
      const deleted = await callTool("hutch_delete_collection", { slug });
      check(deleted.includes("deleted"), `delete_collection: unexpected response: ${deleted.slice(0, 120)}`);
    }
  }
}

async function main() {
  const mode = API_KEY ? "keyed" : "anonymous";
  console.log(`smoke: target ${BASE_URL} (${mode} mode)`);

  if (API_KEY) await checkKeyed();
  else await checkAnonymous();

  if (SMOKE_FULL && failures.length === 0) await checkFull();

  if (failures.length > 0) {
    console.error(`\nsmoke: ${failures.length} failure(s)`);
    for (const f of failures) console.error(`  x ${f}`);
    process.exit(1);
  }
  console.log("smoke: all checks passed");
}

main().catch((err) => {
  console.error("smoke: threw", err);
  process.exit(1);
});
