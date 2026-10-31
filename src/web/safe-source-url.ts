/** Removes query data and rejects unsafe links before a saved source reaches the browser. */
export function safeOfficialSourceUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password) return undefined;
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch { return undefined; }
}
