/**
 * Split a SQL script into statement ranges on semicolons, ignoring semicolons
 * inside single-quoted strings, double-quoted identifiers, dollar-quoted
 * strings ($$…$$ / $tag$…$tag$), line comments and block comments.
 *
 * Not a full parser — but enough that "run statement under cursor" behaves on
 * real-world scripts.
 */

export type StmtRange = { from: number; to: number };

export function splitStatements(text: string): StmtRange[] {
  const ranges: StmtRange[] = [];
  let start = 0;
  let i = 0;
  const n = text.length;

  const push = (to: number) => {
    // Exclude leading whitespace from the range so a cursor sitting on a blank
    // line between statements attaches to the statement above, not below.
    let s = start;
    while (s < to && /\s/.test(text[s])) s++;
    if (s < to) ranges.push({ from: s, to });
    start = to + 1;
  };

  while (i < n) {
    const c = text[i];

    if (c === "'") {
      // Single-quoted string; '' is an escaped quote.
      i++;
      while (i < n) {
        if (text[i] === "'") {
          if (text[i + 1] === "'") i += 2;
          else break;
        } else i++;
      }
      i++;
    } else if (c === '"') {
      // Quoted identifier; "" is an escaped quote.
      i++;
      while (i < n) {
        if (text[i] === '"') {
          if (text[i + 1] === '"') i += 2;
          else break;
        } else i++;
      }
      i++;
    } else if (c === "$") {
      // Possible dollar-quote opener: $tag$ where tag is [A-Za-z0-9_]*
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(text.slice(i));
      if (m) {
        const closer = m[0];
        const end = text.indexOf(closer, i + closer.length);
        i = end === -1 ? n : end + closer.length;
      } else i++;
    } else if (c === "-" && text[i + 1] === "-") {
      const nl = text.indexOf("\n", i);
      i = nl === -1 ? n : nl + 1;
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end === -1 ? n : end + 2;
    } else if (c === ";") {
      push(i);
      i++;
    } else {
      i++;
    }
  }
  push(n);
  return ranges;
}

/**
 * The range of the statement containing `pos`; if `pos` sits in the gap after a
 * statement (e.g. right after its `;` or on a blank line below), the nearest
 * statement above is used. Returns null for an empty script.
 */
export function statementRangeAt(text: string, pos: number): StmtRange | null {
  const ranges = splitStatements(text);
  if (ranges.length === 0) return null;
  let best = ranges[0];
  for (const r of ranges) {
    if (pos >= r.from) best = r;
    else break;
  }
  return best;
}

/**
 * The statement whose range contains `pos` (see {@link statementRangeAt}),
 * trimmed. Returns null for an empty script.
 */
export function statementAt(text: string, pos: number): string | null {
  const r = statementRangeAt(text, pos);
  return r ? text.slice(r.from, r.to).trim() || null : null;
}
