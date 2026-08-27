import { createMcpHandler } from "@modelcontextprotocol/server";
import { createMcpServer } from "@/lib/mcp/server";
import { authenticate } from "@/lib/auth/seam";
import { config } from "@/lib/config";

function unauthorizedResponse(): Response {
  return new Response(JSON.stringify({ error: "Unauthorized" }), {
    status: 401,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * One handler serves both protocol eras: 2026-07-28 traffic natively and
 * 2025-era traffic through the built-in stateless legacy fallback (the
 * default, `legacy: 'stateless'` — a fresh per-request server over a
 * stateless streamable HTTP transport, exactly the previous wiring).
 *
 * The factory runs once per request. Identity is pass-through only: we
 * authenticate below (401 before any MCP handling, same as before) and hand
 * the resulting user/org to the factory via `authInfo.extra` — the handler
 * never inspects or verifies tokens itself.
 */
const handler = createMcpHandler((ctx) => {
  const identity = ctx.authInfo?.extra as { userId: string; orgId: string } | undefined;
  if (!identity) {
    // Unreachable: handleMcpRequest only dispatches authenticated requests.
    throw new Error("MCP request reached the server factory without an authenticated identity");
  }
  return createMcpServer(identity.userId, identity.orgId, config.baseUrl);
});

async function handleMcpRequest(req: Request): Promise<Response> {
  const ctx = await authenticate(req);
  if (!ctx) return unauthorizedResponse();

  return handler.fetch(req, {
    authInfo: {
      token: "",
      clientId: ctx.userId,
      scopes: [],
      extra: { userId: ctx.userId, orgId: ctx.orgId },
    },
  });
}

export const GET = handleMcpRequest;
export const POST = handleMcpRequest;
export const DELETE = handleMcpRequest;
