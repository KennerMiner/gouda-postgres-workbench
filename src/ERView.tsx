import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { CatalogTable } from "./sqlNamespace";

type FkEdge = {
  srcSchema: string;
  srcTable: string;
  srcCols: string[];
  dstSchema: string;
  dstTable: string;
  dstCols: string[];
  name: string;
};

type Pos = { x: number; y: number };

const NODE_W = 190;
const HEAD_H = 24;
const ROW_H = 15;
const MAX_COLS_SHOWN = 10;

function nodeHeight(cols: number): number {
  return HEAD_H + Math.min(cols, MAX_COLS_SHOWN + 1) * ROW_H + 6;
}

export default function ERView({
  connId,
  profileId,
  tables,
}: {
  connId: number;
  profileId: number;
  tables: CatalogTable[];
}) {
  const [edges, setEdges] = useState<FkEdge[]>([]);
  const [positions, setPositions] = useState<Record<string, Pos>>({});
  const [error, setError] = useState("");
  const saveTimer = useRef<number | undefined>(undefined);
  const stateKey = `er:${profileId}`;

  useEffect(() => {
    (async () => {
      try {
        setEdges(await invoke<FkEdge[]>("er_graph", { connId }));
      } catch (e) {
        setError(String(e));
      }
      try {
        const raw = await invoke<string | null>("state_get", { key: stateKey });
        if (raw) setPositions(JSON.parse(raw));
      } catch {
        // default layout below
      }
    })();
  }, [connId, stateKey]);

  // Default grid layout for anything without a saved position.
  const layout = useMemo(() => {
    const out: Record<string, Pos> = { ...positions };
    const names = tables.map((t) => `${t.schema}.${t.name}`).sort();
    const cols = Math.max(1, Math.ceil(Math.sqrt(names.length)));
    names.forEach((n, i) => {
      if (!out[n]) {
        out[n] = { x: 30 + (i % cols) * (NODE_W + 60), y: 30 + Math.floor(i / cols) * 220 };
      }
    });
    return out;
  }, [tables, positions]);

  const persist = (next: Record<string, Pos>) => {
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      invoke("state_set", { key: stateKey, value: JSON.stringify(next) }).catch(() => {});
    }, 500);
  };

  const startDrag = (e: React.MouseEvent, key: string) => {
    e.preventDefault();
    const start = layout[key];
    const sx = e.clientX;
    const sy = e.clientY;
    const move = (ev: MouseEvent) => {
      setPositions((prev) => {
        const next = {
          ...layout,
          ...prev,
          [key]: { x: Math.max(0, start.x + ev.clientX - sx), y: Math.max(0, start.y + ev.clientY - sy) },
        };
        persist(next);
        return next;
      });
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  const fkCols = useMemo(() => {
    const s = new Set<string>();
    for (const e of edges) {
      for (const c of e.srcCols) s.add(`${e.srcSchema}.${e.srcTable}.${c}`);
    }
    return s;
  }, [edges]);

  const canvas = useMemo(() => {
    let w = 400;
    let h = 300;
    for (const [key, p] of Object.entries(layout)) {
      const t = tables.find((tt) => `${tt.schema}.${tt.name}` === key);
      w = Math.max(w, p.x + NODE_W + 60);
      h = Math.max(h, p.y + nodeHeight(t?.columns.length ?? 1) + 60);
    }
    return { w, h };
  }, [layout, tables]);

  const anchor = (key: string, colCount: number): Pos => {
    const p = layout[key] ?? { x: 0, y: 0 };
    return { x: p.x + NODE_W / 2, y: p.y + nodeHeight(colCount) / 2 };
  };

  return (
    <div className="er-view">
      {error && <div className="modal-err">{error}</div>}
      {edges.length === 0 && !error && (
        <div className="er-empty">
          no foreign keys found — the diagram draws FK relationships; drag boxes to arrange
        </div>
      )}
      <div className="er-canvas" style={{ width: canvas.w, height: canvas.h }}>
        <svg className="er-edges" width={canvas.w} height={canvas.h}>
          {edges.map((e, i) => {
            const src = `${e.srcSchema}.${e.srcTable}`;
            const dst = `${e.dstSchema}.${e.dstTable}`;
            const st = tables.find((t) => `${t.schema}.${t.name}` === src);
            const dt = tables.find((t) => `${t.schema}.${t.name}` === dst);
            const a = anchor(src, st?.columns.length ?? 1);
            const b = anchor(dst, dt?.columns.length ?? 1);
            return (
              <g key={i}>
                <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} className="er-line">
                  <title>{`${e.name}: ${src}(${e.srcCols.join(",")}) → ${dst}(${e.dstCols.join(",")})`}</title>
                </line>
                <circle cx={b.x} cy={b.y} r={4} className="er-dot" />
              </g>
            );
          })}
        </svg>
        {tables.map((t) => {
          const key = `${t.schema}.${t.name}`;
          const p = layout[key];
          if (!p) return null;
          const shown = t.columns.slice(0, MAX_COLS_SHOWN);
          return (
            <div key={key} className="er-node" style={{ left: p.x, top: p.y, width: NODE_W }}>
              <div className="er-node-head" onMouseDown={(e) => startDrag(e, key)}>
                {t.name}
              </div>
              {shown.map((c) => (
                <div
                  key={c.name}
                  className={`er-col${fkCols.has(`${key}.${c.name}`) ? " fk" : ""}`}
                >
                  <span className="er-col-name">{c.name}</span>
                  <span className="er-col-type">{c.dataType}</span>
                </div>
              ))}
              {t.columns.length > MAX_COLS_SHOWN && (
                <div className="er-col more">+{t.columns.length - MAX_COLS_SHOWN} more</div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
