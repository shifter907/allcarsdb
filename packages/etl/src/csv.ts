/**
 * A small RFC 4180 CSV reader.
 *
 * Written rather than depended on because the requirements are narrow and the
 * failure modes matter more than the features: these files are edited in Excel
 * and Google Sheets by people contributing car data, so the parser has to cope
 * with a UTF-8 BOM, CRLF line endings, quoted fields containing commas, and
 * doubled quotes -- and it has to report the line number when something is
 * wrong, because "row 4213 has 3 columns, expected 4" is actionable and
 * "unexpected token" is not.
 */

export class CsvError extends Error {}

export interface CsvRow {
  /** 1-based line number in the source file, for error messages. */
  line: number;
  values: Record<string, string>;
}

/**
 * Split CSV text into records. Returns the header names and the data rows.
 *
 * Empty lines are skipped rather than treated as a row of one empty field --
 * a trailing newline at the end of a file is normal, not a malformed record.
 */
export function parseCsv(text: string, file: string): { headers: string[]; rows: CsvRow[] } {
  // Excel writes a BOM. Left in place it becomes part of the first header name,
  // so `Make` silently stops matching and every row looks like it is missing a
  // column that is plainly right there in the file.
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  const records: { line: number; fields: string[] }[] = [];
  let field = '';
  let fields: string[] = [];
  let inQuotes = false;
  let line = 1;
  let recordStartLine = 1;
  let sawAnyChar = false;

  const endField = () => {
    fields.push(field);
    field = '';
  };

  const endRecord = () => {
    endField();
    // A record of a single empty field is a blank line, not data.
    if (!(fields.length === 1 && fields[0]!.trim() === '')) {
      records.push({ line: recordStartLine, fields });
    }
    fields = [];
    sawAnyChar = false;
  };

  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;

    if (!sawAnyChar && fields.length === 0 && field === '') recordStartLine = line;

    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        if (c === '\n') line++;
        field += c;
      }
      sawAnyChar = true;
      continue;
    }

    if (c === '"') {
      if (field !== '') {
        throw new CsvError(`${file}:${line}: a quote may only open a field, not appear inside one`);
      }
      inQuotes = true;
      sawAnyChar = true;
    } else if (c === ',') {
      endField();
      sawAnyChar = true;
    } else if (c === '\r') {
      // Swallow; the \n that follows ends the record.
    } else if (c === '\n') {
      endRecord();
      line++;
    } else {
      field += c;
      sawAnyChar = true;
    }
  }

  if (inQuotes) throw new CsvError(`${file}: file ends inside a quoted field -- unbalanced "`);
  if (field !== '' || fields.length > 0) endRecord();

  const head = records.shift();
  if (!head) throw new CsvError(`${file}: file is empty -- it needs at least a header row`);

  const headers = head.fields.map((h) => h.trim());
  const seen = new Set<string>();
  for (const h of headers) {
    if (!h) throw new CsvError(`${file}:${head.line}: a column header is blank`);
    const key = h.toLowerCase();
    if (seen.has(key)) throw new CsvError(`${file}:${head.line}: duplicate column "${h}"`);
    seen.add(key);
  }

  const rows: CsvRow[] = records.map((r) => {
    if (r.fields.length !== headers.length) {
      throw new CsvError(
        `${file}:${r.line}: found ${r.fields.length} column(s), expected ${headers.length} ` +
          `(${headers.join(', ')}). A comma inside a value needs the value wrapped in quotes.`,
      );
    }
    const values: Record<string, string> = {};
    headers.forEach((h, idx) => {
      values[h] = r.fields[idx]!.trim();
    });
    return { line: r.line, values };
  });

  return { headers, rows };
}

/** Reject a file whose headers are not the ones the loader expects. */
export function requireHeaders(headers: string[], expected: string[], file: string): void {
  const lower = headers.map((h) => h.toLowerCase());
  const missing = expected.filter((e) => !lower.includes(e.toLowerCase()));
  const extra = headers.filter((h) => !expected.some((e) => e.toLowerCase() === h.toLowerCase()));

  if (missing.length || extra.length) {
    const parts: string[] = [];
    if (missing.length) parts.push(`missing column(s): ${missing.join(', ')}`);
    if (extra.length) parts.push(`unexpected column(s): ${extra.join(', ')}`);
    throw new CsvError(
      `${file}: ${parts.join('; ')}. Expected exactly: ${expected.join(', ')}`,
    );
  }
}

/** Read a value by header name, case-insensitively. */
export function get(row: CsvRow, name: string): string {
  const key = Object.keys(row.values).find((k) => k.toLowerCase() === name.toLowerCase());
  return key ? row.values[key]! : '';
}

/**
 * Parse an integer cell. Blank is `null` (unknown), not zero -- the difference
 * between "this engine has no recorded displacement" and "this engine displaces
 * nothing" is the whole point of the distinction.
 */
export function intCell(
  row: CsvRow,
  name: string,
  file: string,
  opts: { min?: number; max?: number; required?: boolean } = {},
): number | null {
  const raw = get(row, name);
  if (raw === '') {
    if (opts.required) throw new CsvError(`${file}:${row.line}: ${name} is required`);
    return null;
  }
  // Tolerate thousands separators, which spreadsheets add when a column is
  // formatted as a number: "2,981" is a displacement, not a malformed row.
  const cleaned = raw.replace(/,/g, '');
  if (!/^-?\d+$/.test(cleaned)) {
    throw new CsvError(`${file}:${row.line}: ${name} is "${raw}", which is not a whole number`);
  }
  const n = Number(cleaned);
  if (opts.min !== undefined && n < opts.min) {
    throw new CsvError(`${file}:${row.line}: ${name} is ${n}, below the minimum of ${opts.min}`);
  }
  if (opts.max !== undefined && n > opts.max) {
    throw new CsvError(`${file}:${row.line}: ${name} is ${n}, above the maximum of ${opts.max}`);
  }
  return n;
}

/** Parse a text cell. Blank becomes `null` rather than an empty string. */
export function textCell(
  row: CsvRow,
  name: string,
  file: string,
  opts: { required?: boolean } = {},
): string | null {
  const raw = get(row, name);
  if (raw === '') {
    if (opts.required) throw new CsvError(`${file}:${row.line}: ${name} is required`);
    return null;
  }
  return raw;
}
