import { readFile } from 'node:fs/promises';

/** Loads simple KEY=value settings from an optional local .env without overriding the process environment. */
export async function loadLocalEnv(path = '.env'): Promise<void> {
  let contents: string;
  try {
    contents = await readFile(path, 'utf8');
  } catch (error) {
    if (isMissingFile(error)) return;
    throw error;
  }

  for (const rawLine of contents.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const assignment = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!assignment) continue;

    const key = assignment[1];
    const rawValue = assignment[2] ?? '';
    if (!key || process.env[key] !== undefined) continue;
    process.env[key] = parseValue(rawValue);
  }
}

await loadLocalEnv();

function isMissingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

function parseValue(rawValue: string): string {
  const value = rawValue.trim();
  const quote = value[0];
  if (quote === '"' || quote === "'") {
    const closingQuote = value.indexOf(quote, 1);
    if (closingQuote < 0) return value.slice(1);
    const quoted = value.slice(1, closingQuote);
    return quote === '"' ? quoted.replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\"/g, '"').replace(/\\\\/g, '\\') : quoted;
  }
  return value.replace(/\s+#.*$/, '').trimEnd();
}
