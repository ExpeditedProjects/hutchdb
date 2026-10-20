import { config } from "@/lib/config";

/**
 * The base URL tool responses link to (`url` on write results). The
 * configured public URL (HUTCH_BASE_URL) wins; otherwise the origin the
 * request actually reached: x-forwarded-host / x-forwarded-proto from a
 * reverse proxy, else the Host header and the request URL's scheme. A
 * forwarded value that is not a bare host[:port] or an http(s) scheme is
 * ignored in favour of the request URL's own origin.
 */
export function publicBaseUrl(req: Request, configured: string | undefined = config.baseUrl): string {
  if (configured && configured.trim() !== "") return configured.trim().replace(/\/+$/, "");
  return requestOrigin(req);
}

const HOST_RE = /^(?:[a-z0-9-]+(?:\.[a-z0-9-]+)*|\[[0-9a-f:.]+\])(?::\d{1,5})?$/i;

function requestOrigin(req: Request): string {
  const url = new URL(req.url);
  const host = firstValue(req.headers.get("x-forwarded-host")) ?? req.headers.get("host") ?? url.host;
  const proto = firstValue(req.headers.get("x-forwarded-proto")) ?? url.protocol.replace(/:$/, "");
  if (!HOST_RE.test(host) || (proto !== "http" && proto !== "https")) return url.origin;
  return `${proto}://${host.toLowerCase()}`;
}

/** Proxies may append to a forwarded header ("a, b"); the first value is the client-facing one. */
function firstValue(header: string | null): string | undefined {
  const first = header?.split(",")[0]?.trim();
  return first ? first : undefined;
}
