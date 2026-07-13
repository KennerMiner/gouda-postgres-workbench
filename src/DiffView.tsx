import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Profile } from "./ConnectionModal";

type DiffLine = { sign: string; text: string };
type TableDiff = { table: string; lines: DiffLine[] };
type SchemaDiff = {
  aLabel: string;
  bLabel: string;
  onlyInA: string[];
  onlyInB: string[];
  changed: TableDiff[];
  identical: number;
};

export default function DiffView({
  profiles,
  defaultA,
}: {
  profiles: Profile[];
  defaultA: number | null;
}) {
  const [a, setA] = useState<number | null>(defaultA ?? profiles[0]?.id ?? null);
  const [b, setB] = useState<number | null>(
    profiles.find((p) => p.id !== (defaultA ?? profiles[0]?.id))?.id ?? null,
  );
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<SchemaDiff | null>(null);
  const [error, setError] = useState("");

  const run = async () => {
    if (a === null || b === null) return;
    setRunning(true);
    setError("");
    setResult(null);
    try {
      setResult(await invoke<SchemaDiff>("schema_diff", { profileA: a, profileB: b }));
    } catch (e) {
      setError(String(e));
    } finally {
      setRunning(false);
    }
  };

  const sel = (v: number | null, set: (n: number) => void) => (
    <select className="ssl-select" value={v ?? ""} onChange={(e) => set(Number(e.target.value))}>
      {profiles.map((p) => (
        <option key={p.id} value={p.id ?? 0}>
          {p.name}
        </option>
      ))}
    </select>
  );

  return (
    <div className="diff-view">
      <div className="diff-toolbar">
        <span className="structure-title">schema diff</span>
        {sel(a, setA)}
        <span className="ai-ctx-sub">vs</span>
        {sel(b, setB)}
        <button className="btn mini primary" disabled={running || a === b} onClick={run}>
          {running ? "comparing…" : "Compare"}
        </button>
        {a === b && <span className="ai-ctx-sub">pick two different profiles</span>}
      </div>
      {error && <div className="modal-err">{error}</div>}

      {result && (
        <div className="diff-body">
          <div className="diff-summary">
            {result.identical} identical table{result.identical === 1 ? "" : "s"} ·{" "}
            {result.changed.length} changed · {result.onlyInA.length} only in {result.aLabel} ·{" "}
            {result.onlyInB.length} only in {result.bLabel}
          </div>

          {result.onlyInA.length > 0 && (
            <>
              <div className="structure-section">Only in {result.aLabel}</div>
              {result.onlyInA.map((t) => (
                <div key={t} className="diff-line plus">+ {t}</div>
              ))}
            </>
          )}
          {result.onlyInB.length > 0 && (
            <>
              <div className="structure-section">Only in {result.bLabel}</div>
              {result.onlyInB.map((t) => (
                <div key={t} className="diff-line minus">- {t}</div>
              ))}
            </>
          )}
          {result.changed.length > 0 && (
            <>
              <div className="structure-section">
                Changed ({result.aLabel} → {result.bLabel})
              </div>
              {result.changed.map((td) => (
                <div key={td.table} className="diff-table">
                  <div className="st-name">{td.table}</div>
                  {td.lines.map((l, i) => (
                    <div
                      key={i}
                      className={`diff-line ${l.sign === "+" ? "plus" : l.sign === "-" ? "minus" : "tilde"}`}
                    >
                      {l.sign} {l.text}
                    </div>
                  ))}
                </div>
              ))}
            </>
          )}
          {result.changed.length === 0 &&
            result.onlyInA.length === 0 &&
            result.onlyInB.length === 0 && (
              <div className="tree-empty">schemas are identical 🎉</div>
            )}
        </div>
      )}
    </div>
  );
}
