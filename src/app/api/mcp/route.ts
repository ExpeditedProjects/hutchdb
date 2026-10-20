import { after } from "next/server";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { createMcpServer } from "@/lib/mcp/server";
import { authenticate } from "@/lib/auth/seam";
import { publicBaseUrl } from "@/lib/base-url";
import { MCP_MAX_REQUEST_BODY_BYTES } from "@/lib/constants";
import { withIndexBuildQueue } from "@/lib/storage/build-queue";

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
  const identity = ctx.authInfo?.extra as { userId: string; orgId: string; baseUrl: string } | undefined;
  if (!identity) {
    // Unreachable: handleMcpRequest only dispatches authenticated requests.
    throw new Error("MCP request reached the server factory without an authenticated identity");
  }
  return createMcpServer(identity.userId, identity.orgId, identity.baseUrl);
}, {
  // The SDK default is 4 MiB and answers larger bodies with a JSON-RPC
  // "Payload Too Large" error; bulk stores and 10 MB imports need more.
  maxRequestBodySize: MCP_MAX_REQUEST_BODY_BYTES,
});

async function handleMcpRequest(req: Request): Promise<Response> {
  const ctx = await authenticate(req);
  if (!ctx) return unauthorizedResponse();

  // Index builds queued while the tools run (writes that crossed an
  // inference threshold, reads that found work left pending) are built
  // after the response is sent, never inside the request.
  return withIndexBuildQueue((drain) => {
    after(drain);
    return handler.fetch(req, {
      authInfo: {
        token: "",
        clientId: ctx.userId,
        scopes: [],
        // Links in tool responses point at the configured public URL, else the origin this request reached.
        extra: { userId: ctx.userId, orgId: ctx.orgId, baseUrl: publicBaseUrl(req) },
      },
    });
  });
}

export const GET = handleMcpRequest;
export const POST = handleMcpRequest;
export const DELETE = handleMcpRequest;
