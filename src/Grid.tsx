import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import Inspector from "./Inspector";
import { copyText } from "./clipboard";

export type ColumnMeta = { name: string; typeName: string; typeOid: number };

export type EditableInfo = {
  schema: string;
  table: string;
  pkIndices: number[];
  editableCols: boolean[];
};

export type CellEdit = {
  column: string;
  castType: string;
  value: string | null;
  pk: { column: string; castType: string; value: string }[];
};

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

/** Text sent to the backend / compared against staged values. NULL is not text. */
function rawText(v: unknown): string {
  if (typeof v === "object" && v !== null) return JSON.stringify(v);
  return String(v);
}

type Sel = { r: number; c: number };

type Props = {
  columns: ColumnMeta[];
  rows: unknown[][];
  editable: EditableInfo | null;
  applyEdits: (
    schema: string,
    table: string,
    edits: CellEdit[],
    dryRun: boolean,
  ) => Promise<string[]>;
  refresh: () => void;
};

export default function Grid({ columns, rows, editable, applyEdits, refresh }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [sel, setSel] = useState<Sel | null>(null);
  const [inspecting, setInspecting] = useState(false);
  // Staged cell edits, keyed "row|col". null = SET NULL.
  const [edits, setEdits] = useState<Map<string, string | null>>(new Map());
  const [editing, setEditing] = useState<Sel | null>(null);
  const [editText, setEditText] = useState("");
  const [preview, setPreview] = useState<string[] | null>(null);
  const [applyErr, setApplyErr] = useState("");
  const [applyBusy, setApplyBusy] = useState(false);

  // New result set: everything cell-scoped is stale.
  useEffect(() => {
    setSel(null);
    setInspecting(false);
    setEdits(new Map());
    setEditing(null);
    setPreview(null);
    setApplyErr("");
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
  const canEditCol = (c: number) => editable !== null && editable.editableCols[c];

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

  const stagedKey = (r: number, c: number) => `${r}|${c}`;

  /** The value a cell currently shows: staged if present, else original. */
  const displayValue = (r: number, c: number): unknown => {
    const key = stagedKey(r, c);
    if (!edits.has(key)) return rows[r][c];
    const staged = edits.get(key)!;
    if (staged === null) return null;
    const orig = rows[r][c];
    const isJsonCol =
      columns[c].typeName === "json" ||
      columns[c].typeName === "jsonb" ||
      (orig !== null && typeof orig === "object");
    if (isJsonCol) {
      try {
        return JSON.parse(staged);
      } catch {
        return staged;
      }
    }
    return staged;
  };

  const stage = useCallback(
    (r: number, c: number, value: string | null) => {
      setEdits((prev) => {
        const next = new Map(prev);
        const key = stagedKey(r, c);
        const orig = rows[r][c];
        const unchanged = value === null ? orig === null : orig !== null && rawText(orig) === value;
        if (unchanged) next.delete(key);
        else next.set(key, value);
        return next;
      });
    },
    [rows],
  );

  const startEdit = useCallback(
    (r: number, c: number) => {
      if (!canEditCol(c)) return;
      const v = rows[r][c];
      // JSON/object cells edit in the inspector, not a 24px input.
      if (typeof v === "object" && v !== null) {
        setSel({ r, c });
        setInspecting(true);
        return;
      }
      const key = stagedKey(r, c);
      const staged = edits.get(key);
      setEditing({ r, c });
      setEditText(edits.has(key) ? (staged ?? "") : v === null ? "" : String(v));
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows, edits, editable],
  );

  const buildEdits = (): CellEdit[] =>
    [...edits.entries()].map(([key, value]) => {
      const [r, c] = key.split("|").map(Number);
      return {
        column: columns[c].name,
        castType: columns[c].typeName,
        value,
        pk: editable!.pkIndices.map((pi) => ({
          column: columns[pi].name,
          castType: columns[pi].typeName,
          value: rawText(rows[r][pi]),
        })),
      };
    });

  const doPreview = async () => {
    if (!editable) return;
    setApplyErr("");
    try {
      setPreview(await applyEdits(editable.schema, editable.table, buildEdits(), true));
    } catch (e) {
      setApplyErr(String(e));
    }
  };

  const doApply = async () => {
    if (!editable) return;
    setApplyBusy(true);
    setApplyErr("");
    try {
      await applyEdits(editable.schema, editable.table, buildEdits(), false);
      setPreview(null);
      setEdits(new Map());
      refresh();
    } catch (e) {
      setApplyErr(String(e));
    } finally {
      setApplyBusy(false);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (rows.length === 0 || editing) return;
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
        if (sel) {
          e.preventDefault();
          if (canEditCol(sel.c) && !(typeof rows[sel.r][sel.c] === "object" && rows[sel.r][sel.c] !== null)) {
            startEdit(sel.r, sel.c);
          } else {
            setInspecting(true);
          }
        }
        break;
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
          copyText(cellText(displayValue(sel.r, sel.c)));
        }
        break;
    }
  };

  const onEditorKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    e.stopPropagation();
    if (!editing) return;
    if (e.key === "Enter") {
      stage(editing.r, editing.c, editText);
      setEditing(null);
    } else if (e.key === "Escape") {
      setEditing(null);
    } else if (e.key === "Backspace" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      stage(editing.r, editing.c, null);
      setEditing(null);
    }
  };

  const selValue = sel ? displayValue(sel.r, sel.c) : undefined;

  const renderCell = (r: number, c: number) => {
    if (editing && editing.r === r && editing.c === c) {
      return (
        <input
          className="cell-input"
          autoFocus
          value={editText}
          onChange={(e) => setEditText(e.target.value)}
          onKeyDown={onEditorKey}
          onBlur={() => setEditing(null)}
          spellCheck={false}
        />
      );
    }
    const staged = edits.has(stagedKey(r, c));
    const v = staged ? displayValue(r, c) : rows[r][c];
    const inner =
      v === null ? (
        <span className="null">NULL</span>
      ) : typeof v === "object" ? (
        <span className="json">{JSON.stringify(v)}</span>
      ) : (
        String(v)
      );
    return inner;
  };

  return (
    <div className="grid-outer">
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
                  {row.map((_, ci) => (
                    <div
                      key={ci}
                      className={`gc${numClass(ci)}${
                        sel && sel.r === vr.index && sel.c === ci ? " sel" : ""
                      }${edits.has(stagedKey(vr.index, ci)) ? " staged" : ""}`}
                      onMouseDown={() => setSel({ r: vr.index, c: ci })}
                      onDoubleClick={() => {
                        setSel({ r: vr.index, c: ci });
                        if (canEditCol(ci)) startEdit(vr.index, ci);
                        else setInspecting(true);
                      }}
                    >
                      {renderCell(vr.index, ci)}
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
            editable={canEditCol(sel.c)}
            onStage={(text) => {
              stage(sel.r, sel.c, text);
              setInspecting(false);
            }}
            onClose={() => setInspecting(false)}
          />
        )}
      </div>

      {edits.size > 0 && (
        <div className="edits-bar">
          <span className="edits-count">
            {edits.size} staged edit{edits.size === 1 ? "" : "s"}
          </span>
          {applyErr && !preview && <span className="edits-err">{applyErr}</span>}
          <span className="spacer" />
          <button className="btn" onClick={() => setEdits(new Map())}>
            Discard
          </button>
          <button className="btn primary" onClick={doPreview}>
            Preview &amp; Apply
          </button>
        </div>
      )}

      {preview && (
        <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && setPreview(null)}>
          <div className="preview-panel">
            <div className="preview-head">
              This will run in a transaction — each statement must match exactly one row:
            </div>
            <pre className="preview-sql">{preview.join(";\n\n") + ";"}</pre>
            {applyErr && <div className="modal-err">{applyErr}</div>}
            <div className="modal-actions">
              <span className="spacer" />
              <button className="btn" disabled={applyBusy} onClick={() => setPreview(null)}>
                Cancel
              </button>
              <button className="btn primary" disabled={applyBusy} onClick={doApply}>
                {applyBusy ? "Applying…" : `Apply ${preview.length} update${preview.length === 1 ? "" : "s"}`}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
