import { useCallback, useMemo, useRef, useState } from "react";
import { Channel, invoke } from "@tauri-apps/api/core";
import "./App.css";

type ColumnMeta = { name: string; typeName: string; typeOid: number };

type QueryEvent =
  | { kind: "meta"; columns: ColumnMeta[] }
  | { kind: "rows"; rows: unknown[][] }
  | { kind: "done"; rowCount: number; elapsedMs: number }
  | { kind: "error"; message: string };

const DEFAULT_DSN = "postgres://heroage:heroage@localhost:5432/heroage";
const DEFAULT_SQL =
  "select table_name, table_type from information_schema.tables where table_schema = 'public' order by 1;";

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

/** Parse enough of a DSN to render the TablePlus-style identity banner. */
function connIdentity(dsn: string): string {
  try {
    const u = new URL(dsn.replace(/^postgres(ql)?:/, "http:"));
    const parts = ["PostgreSQL"];
    if (u.username) parts.push(u.username);
    parts.push(u.hostname || "localhost");
    const db = u.pathname.replace(/^\//, "");
    if (db) parts.push(db);
    return parts.join(" : ");
  } catch {
    return "PostgreSQL";
  }
}

function App() {
  const [dsn, setDsn] = useState(DEFAULT_DSN);
  const [sql, setSql] = useState(DEFAULT_SQL);
  const [columns, setColumns] = useState<ColumnMeta[]>([]);
  const [rows, setRows] = useState<unknown[][]>([]);
  const [status, setStatus] = useState<string>("");
  const [error, setError] = useState<string>("");
  const [running, setRunning] = useState(false);
  const rowBuffer = useRef<unknown[][]>([]);

  const identity = useMemo(() => connIdentity(dsn), [dsn]);

  const run = useCallback(async () => {
    setRunning(true);
    setError("");
    setStatus("");
    setColumns([]);
    setRows([]);
    rowBuffer.current = [];

    const channel = new Channel<QueryEvent>();
    channel.onmessage = (ev) => {
      switch (ev.kind) {
        case "meta":
          setColumns(ev.columns);
          break;
        case "rows":
          // Accumulate in a ref and hand React the same concatenated array so
          // each batch is one rerender, not one per row.
          rowBuffer.current = rowBuffer.current.concat(ev.rows);
          setRows(rowBuffer.current);
          break;
        case "done":
          setStatus(
            `${ev.rowCount.toLocaleString()} row${ev.rowCount === 1 ? "" : "s"} in ${ev.elapsedMs} ms`,
          );
          setRunning(false);
          break;
        case "error":
          setError(ev.message);
          setRunning(false);
          break;
      }
    };

    try {
      await invoke("run_query", { dsn, sql, onEvent: channel });
    } catch (e) {
      setError(String(e));
      setRunning(false);
    }
  }, [dsn, sql]);

  const onEditorKey = (e: React.KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      if (!running) run();
    }
  };

  const align = (c: ColumnMeta) => (NUMERIC_TYPES.has(c.typeName) ? "num" : "");

  return (
    <div className="app">
      {/* Overlay titlebar: this strip sits beside the traffic lights and drags the window. */}
      <div className="titlebar" data-tauri-drag-region>
        <input
          className="dsn"
          value={dsn}
          onChange={(e) => setDsn(e.target.value)}
          spellCheck={false}
          placeholder="postgres://user:pass@host:5432/dbname"
        />
        <button className="run" onClick={run} disabled={running} title="Run (⌘↵)">
          {running ? "Running…" : "▶ Run"}
        </button>
      </div>

      <div className="conn-banner">{identity}</div>

      <textarea
        className="editor"
        value={sql}
        onChange={(e) => setSql(e.target.value)}
        onKeyDown={onEditorKey}
        spellCheck={false}
      />

      <div className="results">
        {error ? (
          <div className="error-pane">{error}</div>
        ) : (
          columns.length > 0 && (
            <table>
              <thead>
                <tr>
                  <th className="rownum" />
                  {columns.map((c, i) => (
                    <th key={i} className={align(c)} title={c.typeName}>
                      {c.name}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r, ri) => (
                  <tr key={ri}>
                    <td className="rownum">{ri + 1}</td>
                    {r.map((cell, ci) => (
                      <td key={ci} className={align(columns[ci])}>
                        {renderCell(cell)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          )
        )}
      </div>

      <div className="statusbar">
        <span className="hint">Run: ⌘↵</span>
        <span className="rowcount">{running ? "running…" : status}</span>
        <span className="engine">PostgreSQL</span>
      </div>
    </div>
  );
}

function renderCell(v: unknown) {
  if (v === null) return <span className="null">NULL</span>;
  if (typeof v === "object") return <span className="json">{JSON.stringify(v)}</span>;
  return String(v);
}

export default App;
