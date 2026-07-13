/** Warning text for statements that deserve a confirm; null = run freely. */
export function confirmDangerous(stmt: string): string | null {
  const cleaned = stmt
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/--[^\n]*/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .toLowerCase();
  const head = cleaned.trimStart();
  if (/^truncate\b/.test(head)) return "TRUNCATE removes ALL rows from the table.\n\nRun it?";
  if (/^drop\b/.test(head)) return "DROP is irreversible.\n\nRun it?";
  if (/^(update|delete)\b/.test(head) && !/\bwhere\b/.test(cleaned)) {
    const verb = head.startsWith("update") ? "UPDATE" : "DELETE";
    return `This ${verb} has no WHERE clause — it affects EVERY row in the table.\n\nRun it?`;
  }
  return null;
}

