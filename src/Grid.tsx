import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import Inspector from "./Inspector";
import { copyText } from "./clipboard";

export type ColumnMeta = { name: string; typeName: string; typeOid: number };

const ROW_H = 24;
const CHAR_W = 6.6; // approximation for 11.5px system font
const MIN_COL = 56;
const MAX_COL = 440;
const SAMPLE = 200;

const NUMERIC_TYPES = new Set([
  "int2",
  "int4",
  "int8",
  "float4",
  "float8",
  "numeric",
  "oid",
  "money",
]);

function cellText(v: unknown): string {
  if (v === null) return "NULL";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

type Sel = { r: number; c: number };

type Props = { columns: ColumnMeta[]; rows: unknown[][] };

export default function Grid({ columns, rows }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [sel, setSel] = useState<Sel | null>(null);
  const [inspecting, setInspecting] = useState(false);

  // New result set: selection and inspector no longer refer to anything real.
  useEffect(() => {
    setSel(null);
    setInspecting(false);
  }, [columns]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_H,
    overscan: 20,
  });

  // Content-measured column widths from a sample of rows (cheap heuristic —
  // resizable columns come later).
  const widths = useMemo(() => {
    const w = columns.map((c) => c.name.length);
    const limit = Math.min(rows.length, SAMPLE);
    for (let r = 0; r < limit; r++) {
      for (let c = 0; c < columns.length; c++) {
        const len = cellText(rows[r][c]).length;
        if (len > w[c]) w[c] = Math.min(len, 70);
      }
    }
    return w.map((chars) => Math.max(MIN_COL, Math.min(MAX_COL, chars * CHAR_W + 21)));
  }, [columns, rows]);

  const gutterW = Math.max(40, String(rows.length).length * 8 + 18);
  const template = `${gutterW}px ${widths.map((w) => `${w}px`).join(" ")}`;
  const totalW = gutterW + widths.reduce((a, b) => a + b, 0);

  const numClass = (i: number) => (NUMERIC_TYPES.has(columns[i].typeName) ? " num" : "");

  const ensureVisible = useCallback(
    (r: number, c: number) => {
      virtualizer.scrollToIndex(r, { align: "auto" });
      const el = scrollRef.current;
      if (!el) return;
      const left = gutterW + widths.slice(0, c).reduce((a, b) => a + b, 0);
      const right = left + widths[c];
      // Keep the sticky gutter out of the usable viewport on the left edge.
      if (left < el.scrollLeft + gutterW) el.scrollLeft = left - gutterW;
      else if (right > el.scrollLeft + el.clientWidth) el.scrollLeft = right - el.clientWidth;
    },
    [virtualizer, widths, gutterW],
  );

  const move = useCallback(
    (dr: number, dc: number) => {
      setSel((prev) => {
        const r = Math.max(0, Math.min(rows.length - 1, (prev?.r ?? 0) + dr));
        const c = Math.max(0, Math.min(columns.length - 1, (prev?.c ?? 0) + dc));
        ensureVisible(r, c);
        return { r, c };
      });
    },
    [rows.length, columns.length, ensureVisible],
  );

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (rows.length === 0) return;
    switch (e.key) {
      case "ArrowUp":
        e.preventDefault();
        move(-1, 0);
        break;
      case "ArrowDown":
        e.preventDefault();
        move(1, 0);
        break;
      case "ArrowLeft":
        e.preventDefault();
        move(0, -1);
        break;
      case "ArrowRight":
        e.preventDefault();
        move(0, 1);
        break;
      case "Enter":
      case " ":
        if (sel) {
          e.preventDefault();
          setInspecting(true);
        }
        break;
      case "Escape":
        e.preventDefault();
        if (inspecting) setInspecting(false);
        else setSel(null);
        break;
      case "c":
        if ((e.metaKey || e.ctrlKey) && sel) {
          e.preventDefault();
          copyText(cellText(rows[sel.r][sel.c]));
        }
        break;
    }
  };

  const selValue = sel ? rows[sel.r]?.[sel.c] : undefined;

  return (
    <div className="grid-wrap">
      <div className="grid-scroll" ref={scrollRef} tabIndex={0} onKeyDown={onKeyDown}>
        <div className="grid-header" style={{ gridTemplateColumns: template, width: totalW }}>
          <div className="gc gutter" />
          {columns.map((c, i) => (
            <div key={i} className={`gc head${numClass(i)}`} title={c.typeName}>
              {c.name}
            </div>
          ))}
        </div>
        <div style={{ height: virtualizer.getTotalSize(), width: totalW, position: "relative" }}>
          {virtualizer.getVirtualItems().map((vr) => {
            const row = rows[vr.index];
            return (
              <div
                key={vr.key}
                className="grid-row"
                style={{
                  gridTemplateColumns: template,
                  transform: `translateY(${vr.start}px)`,
                }}
              >
                <div className="gc gutter">{vr.index + 1}</div>
                {row.map((v, ci) => (
                  <div
                    key={ci}
                    className={`gc${numClass(ci)}${
                      sel && sel.r === vr.index && sel.c === ci ? " sel" : ""
                    }`}
                    onMouseDown={() => setSel({ r: vr.index, c: ci })}
                    onDoubleClick={() => {
                      setSel({ r: vr.index, c: ci });
                      setInspecting(true);
                    }}
                  >
                    {v === null ? (
                      <span className="null">NULL</span>
                    ) : typeof v === "object" ? (
                      <span className="json">{JSON.stringify(v)}</span>
                    ) : (
                      String(v)
                    )}
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      </div>

      {inspecting && sel && selValue !== undefined && (
        <Inspector
          column={columns[sel.c]}
          value={selValue}
          onClose={() => setInspecting(false)}
        />
      )}
    </div>
  );
}
