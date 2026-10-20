/**
 * Split a tool's text result for scripts/mcp-cli.mts: write tools answer
 * with a human summary line, a blank line, then JSON. The CLI prints the
 * human part to stderr and the JSON to stdout, so stdout always parses.
 * Text that is not JSON at all is returned as `human` with json null.
 */
export function splitToolText(text: string): { human: string; json: string | null } {
  const trimmed = text.trim();
  if (isJson(trimmed)) return { human: "", json: trimmed };
  const match = /\n\s*\n(?=[[{])/.exec(trimmed);
  if (match) {
    const json = trimmed.slice(match.index + match[0].length);
    if (isJson(json)) return { human: trimmed.slice(0, match.index), json };
  }
  return { human: trimmed, json: null };
}

function isJson(text: string): boolean {
  if (!/^[[{]/.test(text)) return false;
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}
