/**
 * Zero-dependency RFC 4180 CSV serialization and parsing for record
 * export/import. Records travel as flat rows: system columns
 * (id, created_at, updated_at) first, then the union of top-level data
 * keys in first-seen order. Nested objects/arrays are JSON-stringified
 * into the cell on export and parsed back on import.
 */

/** System columns emitted first on export and ignored on import. */
export const CSV_SYSTEM_COLUMNS = ["id", "created_at", "updated_at"] as const;

/** A record row shaped for export. */
export type ExportRow = {
  id: number;
  created_at: string;
  updated_at: string;
  data: Record<string, unknown>;
};

/** Quote a single CSV field per RFC 4180 (only when it needs it). */
export function escapeCsvField(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function cellValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

/** Serialize a header row + data rows to CSV text (CRLF line endings). */
export function toCsv(headers: string[], rows: string[][]): string {
  const lines = [headers.map(escapeCsvField).join(",")];
  for (const row of rows) {
    lines.push(row.map(escapeCsvField).join(","));
  }
  return lines.join("\r\n") + "\r\n";
}

/**
 * Serialize export rows to CSV. Header is id, created_at, updated_at,
 * then the union of top-level data keys across all rows (first-seen order).
 */
export function recordsToCsv(rows: ExportRow[]): string {
  const dataKeys: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    for (const key of Object.keys(row.data)) {
      if (!seen.has(key)) {
        seen.add(key);
        dataKeys.push(key);
      }
    }
  }

  const headers = [...CSV_SYSTEM_COLUMNS, ...dataKeys];
  const body = rows.map((row) => [
    String(row.id),
    row.created_at,
    row.updated_at,
    ...dataKeys.map((key) => cellValue(row.data[key])),
  ]);
  return toCsv(headers, body);
}

/**
 * Parse CSV text into rows of string cells. Handles quoted fields with
 * embedded commas, double-quote escapes, and CR/LF/CRLF newlines.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;

  const endField = () => {
    row.push(field);
    field = "";
  };
  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
  };

  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
        } else {
          inQuotes = false;
          i++;
        }
      } else {
        field += ch;
        i++;
      }
    } else if (ch === '"' && field === "") {
      inQuotes = true;
      i++;
    } else if (ch === ",") {
      endField();
      i++;
    } else if (ch === "\r") {
      if (text[i + 1] === "\n") i++;
      endRow();
      i++;
    } else if (ch === "\n") {
      endRow();
      i++;
    } else {
      field += ch;
      i++;
    }
  }
  if (field !== "" || row.length > 0) endRow();
  return rows;
}

/**
 * Infer a JSON value from a CSV cell: numeric strings become numbers,
 * "true"/"false" become booleans, JSON-looking cells ({...} or [...])
 * are parsed so nested values round-trip through export, everything
 * else stays a string. Empty cells return undefined (field omitted).
 */
export function coerceCsvValue(raw: string): unknown {
  if (raw === "") return undefined;
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (/^-?(0|[1-9]\d*)(\.\d+)?$/.test(raw)) {
    const n = Number(raw);
    if (Number.isFinite(n)) return n;
  }
  if (raw.startsWith("{") || raw.startsWith("[")) {
    try {
      return JSON.parse(raw);
    } catch {
      // Not valid JSON — keep as string.
    }
  }
  return raw;
}

/**
 * Parse CSV text (header row required) into record data objects.
 * System columns (id, created_at, updated_at) are ignored so
 * hutch_export_records output round-trips cleanly. Fully-empty rows
 * are skipped.
 */
export function csvToRecords(content: string): { records: Record<string, unknown>[] } | { error: string } {
  const rows = parseCsv(content);
  if (rows.length === 0) {
    return { error: "CSV content is empty — a header row is required" };
  }

  const headers = rows[0].map((h) => h.trim());
  if (headers.every((h) => h === "")) {
    return { error: "CSV header row is empty — column names are required" };
  }

  const systemColumns = new Set<string>(CSV_SYSTEM_COLUMNS);
  const records: Record<string, unknown>[] = [];

  for (const cells of rows.slice(1)) {
    if (cells.every((cell) => cell === "")) continue;
    const record: Record<string, unknown> = {};
    for (let c = 0; c < headers.length; c++) {
      const header = headers[c];
      if (header === "" || systemColumns.has(header)) continue;
      const value = coerceCsvValue(cells[c] ?? "");
      if (value !== undefined) record[header] = value;
    }
    records.push(record);
  }

  return { records };
}
