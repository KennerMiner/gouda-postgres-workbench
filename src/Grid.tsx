import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import Inspector from "./Inspector";
import { copyText } from "./clipboard";
import { applyJsonSets, type JsonSetStage } from "./jsonSets";
import { rowsToInsert, rowsToTsv } from "./rowCopy";
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
  onExport: (format: "csv" | "json") => void;
  onStructure: () => void;
};

export default function Grid({
  columns,
  rows,
  editable,
  applyChanges,
  refresh,
  onExport,
  onStructure,
}: Props) {
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
  const [sort, setSort] = useState<{ c: number; dir: 1 | -1 } | null>(null);
  // Selected SOURCE row indices + the display-index anchor for shift ranges.
  const [rowSel, setRowSel] = useState<Set<number>>(new Set());
  const rowAnchor = useRef<number | null>(null);
  const [widthOverrides, setWidthOverrides] = useState<Map<number, number>>(new Map());
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
    setSort(null);
    setWidthOverrides(new Map());
    setRowSel(new Set());
  }, [columns]);

  const total = rows.length + inserts.length;
  const isInsertRow = (r: number) => r >= rows.length;

  // Display order: sorting permutes an index array; edits/deletes/selection
  // data stay keyed to SOURCE row indices. Pending insert rows always render
  // after all real rows and are unaffected by sort.
  const order = useMemo(() => {
    const idx = rows.map((_, i) => i);
    if (!sort) return idx;
    const { c, dir } = sort;
    const numeric = NUMERIC_TYPES.has(columns[c]?.typeName ?? "");
    idx.sort((a, b) => {
      const va = rows[a][c];
      const vb = rows[b][c];
      if (va === null && vb === null) return 0;
      if (va === null) return 1; // nulls last regardless of direction
      if (vb === null) return -1;
      let cmp: number;
      if (numeric || (typeof va === "number" && typeof vb === "number")) {
        cmp = Number(va) - Number(vb);
      } else {
        cmp = cellText(va).localeCompare(cellText(vb));
      }
      return cmp * dir;
    });
    return idx;
  }, [rows, sort, columns]);

  /** Display row -> source row (insert rows map to themselves). */
  const toSrc = (d: number) => (d >= rows.length ? d : order[d]);

  const cycleSort = (c: number) =>
    setSort((prev) =>
      prev?.c !== c ? { c, dir: 1 } : prev.dir === 1 ? { c, dir: -1 } : null,
    );

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
    return w.map((chars, i) =>
      widthOverrides.get(i) ?? Math.max(MIN_COL, Math.min(MAX_COL, chars * CHAR_W + 21)),
    );
  }, [columns, rows, widthOverrides]);

  const startResize = (e: React.MouseEvent, c: number) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startW = widths[c];
    const move = (ev: MouseEvent) =>
      setWidthOverrides((prev) =>
        new Map(prev).set(c, Math.max(40, Math.min(900, startW + ev.clientX - startX))),
      );
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      document.body.classList.remove("col-resizing");
    };
    document.body.classList.add("col-resizing");
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

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
      // (Callers own selection state — r here is a SOURCE index, sel is display.)
      if (typeof v === "object" && v !== null) {
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

  const gutterClick = (e: React.MouseEvent, d: number) => {
    if (isInsertRow(toSrc(d))) return;
    e.preventDefault();
    setSel(null);
    setRowSel((prev) => {
      const next = new Set(prev);
      const src = toSrc(d);
      if (e.shiftKey && rowAnchor.current !== null) {
        const [a, b] = [Math.min(rowAnchor.current, d), Math.max(rowAnchor.current, d)];
        for (let i = a; i <= b && i < rows.length; i++) next.add(toSrc(i));
      } else if (e.metaKey || e.ctrlKey) {
        if (next.has(src)) next.delete(src);
        else next.add(src);
        rowAnchor.current = d;
      } else {
        next.clear();
        next.add(src);
        rowAnchor.current = d;
      }
      return next;
    });
  };

  /** Selected rows in display order (stable, readable output). */
  const selectedRowData = () => order.filter((src) => rowSel.has(src)).map((src) => rows[src]);

  const copyRows = (format: "tsv" | "insert") => {
    const data = selectedRowData();
    if (!data.length) return;
    if (format === "tsv") {
      copyText(rowsToTsv(data));
    } else {
      const table = editable
        ? `"${editable.schema.replace(/"/g, '""')}"."${editable.table.replace(/"/g, '""')}"`
        : '"table"';
      copyText(rowsToInsert(table, columns, data));
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
          const src = toSrc(sel.r);
          const v = isInsertRow(src) ? undefined : rows[src][sel.c];
          if (canEditCol(sel.c) && !(typeof v === "object" && v !== null)) {
            startEdit(src, sel.c);
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
        else if (rowSel.size) setRowSel(new Set());
        else setSel(null);
        break;
      case "Backspace":
        if ((e.metaKey || e.ctrlKey) && sel) {
          e.preventDefault();
          if (isInsertRow(sel.r)) {
            removeInsertRow(sel.r - rows.length);
            setSel(null);
          } else if (editable) {
            toggleDelete(toSrc(sel.r));
          }
        }
        break;
      case "c":
        if ((e.metaKey || e.ctrlKey) && rowSel.size) {
          e.preventDefault();
          copyRows("tsv");
        } else if ((e.metaKey || e.ctrlKey) && sel) {
          e.preventDefault();
          copyText(cellText(displayValue(toSrc(sel.r), sel.c) ?? null));
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

  const selValue = sel && !isInsertRow(sel.r) ? displayValue(toSrc(sel.r), sel.c) : undefined;

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
              <div
                key={i}
                className={`gc head${numClass(i)}`}
                title={`${c.typeName} — click to sort`}
                onClick={() => cycleSort(i)}
              >
                {c.name}
                {sort?.c === i && <span className="sort-arrow">{sort.dir === 1 ? "▲" : "▼"}</span>}
                <span
                  className="col-resize-handle"
                  onMouseDown={(e) => startResize(e, i)}
                  onClick={(e) => e.stopPropagation()}
                  onDoubleClick={(e) => {
                    e.stopPropagation();
                    setWidthOverrides((prev) => {
                      const next = new Map(prev);
                      next.delete(i);
                      return next;
                    });
                  }}
                />
              </div>
            ))}
          </div>
          <div style={{ height: virtualizer.getTotalSize(), width: totalW, position: "relative" }}>
            {virtualizer.getVirtualItems().map((vr) => {
              const d = vr.index; // display position
              const src = toSrc(d); // source row (data domain)
              const insert = isInsertRow(src);
              const deleted = !insert && deletes.has(src);
              return (
                <div
                  key={vr.key}
                  className={`grid-row${insert ? " insert" : ""}${deleted ? " deleted" : ""}${
                    !insert && rowSel.has(src) ? " rowsel" : ""
                  }`}
                  style={{
                    gridTemplateColumns: template,
                    transform: `translateY(${vr.start}px)`,
                  }}
                >
                  <div
                    className="gc gutter"
                    onMouseDown={(e) => gutterClick(e, d)}
                    title={insert ? "" : "click selects row · shift extends · ⌘ toggles"}
                  >
                    {insert ? "+" : d + 1}
                  </div>
                  {columns.map((_, ci) => (
                    <div
                      key={ci}
                      className={`gc${numClass(ci)}${
                        sel && sel.r === d && sel.c === ci ? " sel" : ""
                      }${!insert && edits.has(stagedKey(src, ci)) ? " staged" : ""}`}
                      onMouseDown={() => setSel({ r: d, c: ci })}
                      onDoubleClick={() => {
                        setSel({ r: d, c: ci });
                        if (canEditCol(ci)) startEdit(src, ci);
                        else if (!insert) setInspecting(true);
                      }}
                    >
                      {renderCell(src, ci)}
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
              stage(toSrc(sel.r), sel.c, text);
              setInspecting(false);
            }}
            onStageJsonSet={
              canEditCol(sel.c) &&
              (columns[sel.c].typeName === "jsonb" || columns[sel.c].typeName === "json")
                ? (path, value) => stageJsonSet(toSrc(sel.r), sel.c, path, value)
                : undefined
            }
            onClose={() => setInspecting(false)}
          />
        )}
      </div>

      <div className="grid-toolbar">
        {editable && (
          <>
            <button className="btn mini" onClick={addRow}>
              + Row
            </button>
            <span className="grid-toolbar-hint">
              ⌘⌫ marks row for delete · empty new cell = DEFAULT
            </span>
          </>
        )}
        {rowSel.size > 0 && (
          <>
            <span className="edits-count">{rowSel.size} row{rowSel.size === 1 ? "" : "s"}</span>
            <button className="btn mini" onClick={() => copyRows("tsv")}>
              Copy TSV
            </button>
            <button className="btn mini" onClick={() => copyRows("insert")}>
              Copy INSERT
            </button>
          </>
        )}
        <span className="spacer" />
        {editable && (
          <button className="btn mini" onClick={onStructure}>
            Structure
          </button>
        )}
        {rows.length > 0 && (
          <>
            <button className="btn mini" onClick={() => onExport("csv")}>
              Export CSV
            </button>
            <button className="btn mini" onClick={() => onExport("json")}>
              Export JSON
            </button>
          </>
        )}
      </div>

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
