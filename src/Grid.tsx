import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import Inspector from "./Inspector";
import { copyText } from "./clipboard";
import { applyJsonSets, type JsonSetStage } from "./jsonSets";
import type { Path } from "./JsonTree";

export type ColumnMeta = { name: string; typeName: string; typeOid: number };

export type EditableInfo = {
  schema: string;
  table: string;
  pkIndices: number[];
  editableCols: boolean[];
};

type PkVal = { column: string; castType: string; value: string };
type InsertCell = { column: string; castType: string; value: string | null };

export type ChangeSet = {
  edits: {
    column: string;
    castType: string;
    value: string | null;
    jsonSets?: { path: string[]; value: string }[];
    pk: PkVal[];
  }[];
  deletes: { pk: PkVal[] }[];
  inserts: { cells: InsertCell[] }[];
};

/** A staged cell: whole-value replacement (null = SET NULL) or node edits. */
type Staged = { kind: "value"; value: string | null } | { kind: "sets"; sets: JsonSetStage[] };

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
  applyChanges: (
    schema: string,
    table: string,
    changes: ChangeSet,
    dryRun: boolean,
  ) => Promise<string[]>;
  refresh: () => void;
};

export default function Grid({ columns, rows, editable, applyChanges, refresh }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [sel, setSel] = useState<Sel | null>(null);
  const [inspecting, setInspecting] = useState(false);
  // Staged cell edits on existing rows, keyed "row|col".
  const [edits, setEdits] = useState<Map<string, Staged>>(new Map());
  // Row indices staged for deletion.
  const [deletes, setDeletes] = useState<Set<number>>(new Set());
  // Pending new rows: per row, colIdx -> value (null = explicit NULL;
  // missing = column DEFAULT).
  const [inserts, setInserts] = useState<Map<number, string | null>[]>([]);
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
    setDeletes(new Set());
    setInserts([]);
    setEditing(null);
    setPreview(null);
    setApplyErr("");
  }, [columns]);

  const total = rows.length + inserts.length;
  const isInsertRow = (r: number) => r >= rows.length;

  const virtualizer = useVirtualizer({
    count: total,
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

  const gutterW = Math.max(40, String(total).length * 8 + 18);
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
        const r = Math.max(0, Math.min(total - 1, (prev?.r ?? 0) + dr));
        const c = Math.max(0, Math.min(columns.length - 1, (prev?.c ?? 0) + dc));
        ensureVisible(r, c);
        return { r, c };
      });
    },
    [total, columns.length, ensureVisible],
  );

  const stagedKey = (r: number, c: number) => `${r}|${c}`;

  /** The value a cell currently shows: staged if present, else original. */
  const displayValue = (r: number, c: number): unknown => {
    if (isInsertRow(r)) {
      const m = inserts[r - rows.length];
      if (!m || !m.has(c)) return undefined; // DEFAULT
      const v = m.get(c)!;
      return v;
    }
    const key = stagedKey(r, c);
    if (!edits.has(key)) return rows[r][c];
    const staged = edits.get(key)!;
    if (staged.kind === "sets") return applyJsonSets(rows[r][c], staged.sets);
    if (staged.value === null) return null;
    const orig = rows[r][c];
    const isJsonCol =
      columns[c].typeName === "json" ||
      columns[c].typeName === "jsonb" ||
      (orig !== null && typeof orig === "object");
    if (isJsonCol) {
      try {
        return JSON.parse(staged.value);
      } catch {
        return staged.value;
      }
    }
    return staged.value;
  };

  const stage = useCallback(
    (r: number, c: number, value: string | null) => {
      if (isInsertRow(r)) {
        setInserts((prev) => {
          const next = prev.map((m) => new Map(m));
          next[r - rows.length].set(c, value);
          return next;
        });
        return;
      }
      setEdits((prev) => {
        const next = new Map(prev);
        const key = stagedKey(r, c);
        const orig = rows[r][c];
        const unchanged = value === null ? orig === null : orig !== null && rawText(orig) === value;
        if (unchanged) next.delete(key);
        else next.set(key, { kind: "value", value });
        return next;
      });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows],
  );

  /** Stage a node-level JSON edit. Whole-value staging (if any) absorbs it. */
  const stageJsonSet = useCallback(
    (r: number, c: number, path: Path, value: string) => {
      setEdits((prev) => {
        const next = new Map(prev);
        const key = stagedKey(r, c);
        const existing = next.get(key);
        if (existing?.kind === "value" && existing.value !== null) {
          // Cell already staged as a whole document: fold the node edit in.
          try {
            const doc = applyJsonSets(JSON.parse(existing.value), [{ path, value }]);
            next.set(key, { kind: "value", value: JSON.stringify(doc) });
            return next;
          } catch {
            // fall through to sets form
          }
        }
        const sets = existing?.kind === "sets" ? [...existing.sets] : [];
        // Re-editing the same node replaces its earlier set.
        const i = sets.findIndex((s) => s.path.join("") === path.join(""));
        if (i >= 0) sets[i] = { path, value };
        else sets.push({ path, value });
        next.set(key, { kind: "sets", sets });
        return next;
      });
    },
    [],
  );

  const startEdit = useCallback(
    (r: number, c: number) => {
      if (!canEditCol(c)) return;
      if (isInsertRow(r)) {
        const m = inserts[r - rows.length];
        setEditing({ r, c });
        setEditText(m?.has(c) ? (m.get(c) ?? "") : "");
        return;
      }
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
      setEditText(
        staged?.kind === "value" ? (staged.value ?? "") : v === null ? "" : String(v),
      );
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows, edits, inserts, editable],
  );

  const addRow = () => {
    setInserts((prev) => [...prev, new Map()]);
    requestAnimationFrame(() => virtualizer.scrollToIndex(total, { align: "end" }));
  };

  const toggleDelete = (r: number) => {
    setDeletes((prev) => {
      const next = new Set(prev);
      if (next.has(r)) next.delete(r);
      else next.add(r);
      return next;
    });
  };

  const removeInsertRow = (i: number) =>
    setInserts((prev) => prev.filter((_, idx) => idx !== i));

  const pkOf = (r: number): PkVal[] =>
    editable!.pkIndices.map((pi) => ({
      column: columns[pi].name,
      castType: columns[pi].typeName,
      value: rawText(rows[r][pi]),
    }));

  const buildChanges = (): ChangeSet => ({
    edits: [...edits.entries()]
      .filter(([key]) => !deletes.has(Number(key.split("|")[0])))
      .map(([key, staged]) => {
        const [r, c] = key.split("|").map(Number);
        return {
          column: columns[c].name,
          castType: columns[c].typeName,
          value: staged.kind === "value" ? staged.value : null,
          jsonSets:
            staged.kind === "sets"
              ? staged.sets.map((s) => ({ path: s.path.map(String), value: s.value }))
              : undefined,
          pk: pkOf(r),
        };
      }),
    deletes: [...deletes].map((r) => ({ pk: pkOf(r) })),
    inserts: inserts.map((m) => ({
      cells: [...m.entries()]
        .filter(([c]) => canEditCol(c))
        .map(([c, value]) => ({
          column: columns[c].name,
          castType: columns[c].typeName,
          value,
        })),
    })),
  });

  const changeCount =
    [...edits.keys()].filter((key) => !deletes.has(Number(key.split("|")[0]))).length +
    deletes.size +
    inserts.length;

  const changeSummary = () => {
    const parts: string[] = [];
    const editCount = [...edits.keys()].filter(
      (key) => !deletes.has(Number(key.split("|")[0])),
    ).length;
    if (editCount) parts.push(`${editCount} edit${editCount === 1 ? "" : "s"}`);
    if (deletes.size) parts.push(`${deletes.size} delete${deletes.size === 1 ? "" : "s"}`);
    if (inserts.length) parts.push(`${inserts.length} new row${inserts.length === 1 ? "" : "s"}`);
    return parts.join(" · ");
  };

  const discardAll = () => {
    setEdits(new Map());
    setDeletes(new Set());
    setInserts([]);
  };

  const doPreview = async () => {
    if (!editable) return;
    setApplyErr("");
    try {
      setPreview(await applyChanges(editable.schema, editable.table, buildChanges(), true));
    } catch (e) {
      setApplyErr(String(e));
    }
  };

  const doApply = async () => {
    if (!editable) return;
    setApplyBusy(true);
    setApplyErr("");
    try {
      await applyChanges(editable.schema, editable.table, buildChanges(), false);
      setPreview(null);
      discardAll();
      refresh();
    } catch (e) {
      setApplyErr(String(e));
    } finally {
      setApplyBusy(false);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (total === 0 || editing) return;
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
          const v = isInsertRow(sel.r) ? undefined : rows[sel.r][sel.c];
          if (canEditCol(sel.c) && !(typeof v === "object" && v !== null)) {
            startEdit(sel.r, sel.c);
          } else {
            setInspecting(true);
          }
        }
        break;
      case " ":
        if (sel && !isInsertRow(sel.r)) {
          e.preventDefault();
          setInspecting(true);
        }
        break;
      case "Escape":
        e.preventDefault();
        if (inspecting) setInspecting(false);
        else setSel(null);
        break;
      case "Backspace":
        if ((e.metaKey || e.ctrlKey) && sel) {
          e.preventDefault();
          if (isInsertRow(sel.r)) {
            removeInsertRow(sel.r - rows.length);
            setSel(null);
          } else if (editable) {
            toggleDelete(sel.r);
          }
        }
        break;
      case "c":
        if ((e.metaKey || e.ctrlKey) && sel) {
          e.preventDefault();
          copyText(cellText(displayValue(sel.r, sel.c) ?? null));
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

  const selValue = sel && !isInsertRow(sel.r) ? displayValue(sel.r, sel.c) : undefined;

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
    if (isInsertRow(r)) {
      const m = inserts[r - rows.length];
      if (!m || !m.has(c))
        return <span className="default-hint">{canEditCol(c) ? "default" : ""}</span>;
      const v = m.get(c)!;
      return v === null ? <span className="null">NULL</span> : v;
    }
    const staged = edits.has(stagedKey(r, c));
    const v = staged ? displayValue(r, c) : rows[r][c];
    return v === null ? (
      <span className="null">NULL</span>
    ) : typeof v === "object" ? (
      <span className="json">{JSON.stringify(v)}</span>
    ) : (
      String(v)
    );
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
              const r = vr.index;
              const insert = isInsertRow(r);
              const deleted = !insert && deletes.has(r);
              return (
                <div
                  key={vr.key}
                  className={`grid-row${insert ? " insert" : ""}${deleted ? " deleted" : ""}`}
                  style={{
                    gridTemplateColumns: template,
                    transform: `translateY(${vr.start}px)`,
                  }}
                >
                  <div className="gc gutter">{insert ? "+" : r + 1}</div>
                  {columns.map((_, ci) => (
                    <div
                      key={ci}
                      className={`gc${numClass(ci)}${
                        sel && sel.r === r && sel.c === ci ? " sel" : ""
                      }${!insert && edits.has(stagedKey(r, ci)) ? " staged" : ""}`}
                      onMouseDown={() => setSel({ r, c: ci })}
                      onDoubleClick={() => {
                        setSel({ r, c: ci });
                        if (canEditCol(ci)) startEdit(r, ci);
                        else if (!insert) setInspecting(true);
                      }}
                    >
                      {renderCell(r, ci)}
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
            onStageJsonSet={
              canEditCol(sel.c) &&
              (columns[sel.c].typeName === "jsonb" || columns[sel.c].typeName === "json")
                ? (path, value) => stageJsonSet(sel.r, sel.c, path, value)
                : undefined
            }
            onClose={() => setInspecting(false)}
          />
        )}
      </div>

      {editable && (
        <div className="grid-toolbar">
          <button className="btn mini" onClick={addRow}>
            + Row
          </button>
          <span className="grid-toolbar-hint">⌘⌫ marks row for delete · empty new cell = DEFAULT</span>
        </div>
      )}

      {changeCount > 0 && (
        <div className="edits-bar">
          <span className="edits-count">{changeSummary()}</span>
          {applyErr && !preview && <span className="edits-err">{applyErr}</span>}
          <span className="spacer" />
          <button className="btn" onClick={discardAll}>
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
              This will run in a transaction — each statement must affect exactly one row:
            </div>
            <pre className="preview-sql">{preview.join(";\n\n") + ";"}</pre>
            {applyErr && <div className="modal-err">{applyErr}</div>}
            <div className="modal-actions">
              <span className="spacer" />
              <button className="btn" disabled={applyBusy} onClick={() => setPreview(null)}>
                Cancel
              </button>
              <button className="btn primary" disabled={applyBusy} onClick={doApply}>
                {applyBusy
                  ? "Applying…"
                  : `Apply ${preview.length} change${preview.length === 1 ? "" : "s"}`}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
