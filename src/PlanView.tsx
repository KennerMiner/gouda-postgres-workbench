import { useState } from "react";

/**
 * Visual EXPLAIN tree. Accepts the JSON produced by
 * `EXPLAIN (FORMAT JSON [, ANALYZE, BUFFERS])` — one root per statement.
 */

export type PlanNode = {
  "Node Type": string;
  Plans?: PlanNode[];
  [key: string]: unknown;
};

export type PlanRoot = {
  Plan: PlanNode;
  "Planning Time"?: number;
  "Execution Time"?: number;
};

const num = (v: unknown): number | null => (typeof v === "number" ? v : null);

/** Total time spent in this node across all loop iterations (analyze only). */
export function inclusiveTime(n: PlanNode): number | null {
  const t = num(n["Actual Total Time"]);
  if (t === null) return null;
  return t * (num(n["Actual Loops"]) ?? 1);
}

/** Inclusive time minus children — where the node itself burned time. */
export function selfTime(n: PlanNode): number | null {
  const inc = inclusiveTime(n);
  if (inc === null) return null;
  const kids = (n.Plans ?? []).reduce((a, k) => a + (inclusiveTime(k) ?? 0), 0);
  return Math.max(0, inc - kids);
}

/** Total rows produced (per-loop average × loops). */
export function actualRows(n: PlanNode): number | null {
  const r = num(n["Actual Rows"]);
  if (r === null) return null;
  return r * (num(n["Actual Loops"]) ?? 1);
}

/** How far the planner's row estimate was off, as a ×factor (≥1). */
export function estimateFactor(n: PlanNode): number | null {
  const est = num(n["Plan Rows"]);
  const act = actualRows(n);
  if (est === null || act === null) return null;
  const a = Math.max(1, act);
  const e = Math.max(1, est);
  return Math.max(a / e, e / a);
}

function target(n: PlanNode): string {
  const parts: string[] = [];
  if (n["Relation Name"]) parts.push(String(n["Relation Name"]));
  if (n["Index Name"]) parts.push(`using ${n["Index Name"]}`);
  if (n["Function Name"]) parts.push(String(n["Function Name"]));
  if (n["Alias"] && n["Alias"] !== n["Relation Name"]) parts.push(`as ${n["Alias"]}`);
  if (n["Join Type"]) parts.push(`(${n["Join Type"]})`);
  return parts.join(" ");
}

function conditions(n: PlanNode): string[] {
  const keys = ["Index Cond", "Recheck Cond", "Hash Cond", "Merge Cond", "Join Filter", "Filter", "Sort Key", "Group Key"];
  return keys
    .filter((k) => n[k] !== undefined)
    .map((k) => `${k}: ${Array.isArray(n[k]) ? (n[k] as unknown[]).join(", ") : n[k]}`);
}

function heat(frac: number): string {
  if (frac > 0.5) return "hot";
  if (frac > 0.2) return "warm";
  return "";
}

function Node({ n, depth, total }: { n: PlanNode; depth: number; total: number }) {
  const [open, setOpen] = useState(true);
  const kids = n.Plans ?? [];
  const inc = inclusiveTime(n);
  const self = selfTime(n);
  // Bar fraction: time when analyzed, cost otherwise.
  const metric = inc ?? num(n["Total Cost"]) ?? 0;
  const frac = total > 0 ? Math.min(1, metric / total) : 0;
  const selfFrac = total > 0 && self !== null ? self / total : frac;
  const est = estimateFactor(n);
  const removed = num(n["Rows Removed by Filter"]);

  return (
    <div>
      <div className={`plan-row ${heat(selfFrac)}`} style={{ paddingLeft: depth * 18 }}>
        <div className="plan-bar" style={{ width: `${Math.max(1, frac * 100)}%` }} />
        <span className="plan-chevron" onClick={() => kids.length && setOpen(!open)}>
          {kids.length ? (open ? "⌄" : "›") : ""}
        </span>
        <span className="plan-type">{n["Node Type"]}</span>
        <span className="plan-target">{target(n)}</span>
        {est !== null && est >= 10 && (
          <span className="plan-badge" title="Planner row estimate vs actual">
            est ×{Math.round(est)} off
          </span>
        )}
        {removed !== null && removed > 10000 && (
          <span className="plan-badge warn" title="Rows read then discarded by the filter">
            {removed.toLocaleString()} filtered out
          </span>
        )}
        <span className="plan-metrics">
          {inc !== null ? `${inc.toFixed(1)} ms` : `cost ${num(n["Total Cost"])?.toFixed(0) ?? "?"}`}
          {" · "}
          {actualRows(n) !== null
            ? `${actualRows(n)!.toLocaleString()} rows`
            : `~${num(n["Plan Rows"])?.toLocaleString() ?? "?"} rows`}
        </span>
      </div>
      {conditions(n).map((c, i) => (
        <div key={i} className="plan-cond" style={{ paddingLeft: depth * 18 + 34 }}>
          {c}
        </div>
      ))}
      {open && kids.map((k, i) => <Node key={i} n={k} depth={depth + 1} total={total} />)}
    </div>
  );
}

export default function PlanView({ roots }: { roots: PlanRoot[] }) {
  return (
    <div className="plan-view">
      {roots.map((r, i) => {
        const total = inclusiveTime(r.Plan) ?? num(r.Plan["Total Cost"]) ?? 0;
        return (
          <div key={i}>
            <div className="plan-summary">
              {r["Planning Time"] !== undefined && `planning ${r["Planning Time"]} ms`}
              {r["Execution Time"] !== undefined && ` · execution ${r["Execution Time"]} ms`}
              {r["Execution Time"] === undefined && "estimated plan (not executed)"}
            </div>
            <Node n={r.Plan} depth={0} total={total} />
          </div>
        );
      })}
    </div>
  );
}
