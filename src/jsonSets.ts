import type { Path } from "./JsonTree";

export type JsonSetStage = { path: Path; value: string };

/**
 * Apply staged node edits to a document the way Postgres jsonb_set does:
 * the final path element is created if missing, but a missing/scalar
 * intermediate makes that set a no-op.
 */
export function applyJsonSets(orig: unknown, sets: JsonSetStage[]): unknown {
  let doc: unknown = orig === undefined ? null : structuredClone(orig);
  for (const s of sets) {
    let val: unknown;
    try {
      val = JSON.parse(s.value);
    } catch {
      continue; // invalid staged text never leaves the editor, but be safe
    }
    if (s.path.length === 0) continue; // matches backend: empty path rejected
    if (doc === null || typeof doc !== "object") continue;
    let cur: Record<string | number, unknown> | null = doc as Record<string | number, unknown>;
    for (let i = 0; i < s.path.length - 1; i++) {
      const next: unknown = cur[s.path[i]];
      if (next === null || typeof next !== "object") {
        cur = null;
        break;
      }
      cur = next as Record<string | number, unknown>;
    }
    if (cur !== null) cur[s.path[s.path.length - 1]] = val;
  }
  return doc;
}
