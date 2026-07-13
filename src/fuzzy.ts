/**
 * Tiny fuzzy matcher for the command palette. Substring beats subsequence,
 * word-start and label-start matches boost, shorter labels win ties.
 * Returns null when the query doesn't match at all.
 */
export function fuzzyScore(query: string, label: string): number | null {
  const q = query.toLowerCase();
  const l = label.toLowerCase();
  if (!q) return 0;

  const sub = l.indexOf(q);
  if (sub >= 0) {
    let score = 100 - sub - label.length * 0.1;
    if (sub === 0) score += 40;
    else if (/[\s._:-]/.test(l[sub - 1])) score += 20;
    return score;
  }

  // Subsequence: every query char in order.
  let li = 0;
  let score = 0;
  for (const ch of q) {
    const found = l.indexOf(ch, li);
    if (found === -1) return null;
    score -= (found - li) * 0.5; // penalize gaps
    li = found + 1;
  }
  return score - label.length * 0.1;
}
