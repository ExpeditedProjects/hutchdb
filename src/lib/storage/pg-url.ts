/**
 * The connection URL without its password, and the password (from the
 * userinfo or a ?password= parameter), so the password reaches pg_dump in
 * its environment, never its argv (visible to every local user in ps).
 */
export function splitPassword(url: string): { url: string; password: string | undefined } {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { url, password: undefined };
  }
  let password = parsed.password ? decodeURIComponent(parsed.password) : undefined;
  const param = parsed.searchParams.get("password");
  if (param !== null) {
    password ??= param;
    parsed.searchParams.delete("password");
  }
  parsed.password = "";
  return { url: parsed.toString(), password };
}
