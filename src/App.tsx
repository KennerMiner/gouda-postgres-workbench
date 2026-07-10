import { useCallback, useRef, useState } from "react";
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

function App() {
  const [dsn, setDsn] = useState(DEFAULT_DSN);
  const [sql, setSql] = useState(DEFAULT_SQL);
  const [columns, setColumns] = useState<ColumnMeta[]>([]);
  const [rows, setRows] = useState<unknown[][]>([]);
  const [status, setStatus] = useState<string>("");
  const [error, setError] = useState<string>("");
  const [running, setRunning] = useState(false);
  const rowBuffer = useRef<unknown[][]>([]);

  const run = useCallback(async () => {
    setRunning(true);
    setError("");
    setStatus("running…");
    setColumns([]);
    setRows([]);
    rowBuffer.current = [];
    const started = performance.now();

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
            `${ev.rowCount} row${ev.rowCount === 1 ? "" : "s"} · ${ev.elapsedMs} ms (server) · ${Math.round(
              performance.now() - started,
            )} ms (round trip)`,
          );
          setRunning(false);
          break;
        case "error":
          setError(ev.message);
          setStatus("");
          setRunning(false);
          break;
      }
    };

    try {
      await invoke("run_query", { dsn, sql, onEvent: channel });
    } catch (e) {
      setError(String(e));
      setStatus("");
      setRunning(false);
    }
  }, [dsn, sql]);

  const onEditorKey = (e: React.KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      if (!running) run();
    }
  };

  return (
    <div className="app">
      <div className="toolbar">
        <input
          className="dsn"
          value={dsn}
          onChange={(e) => setDsn(e.target.value)}
          spellCheck={false}
          placeholder="postgres://user:pass@host:5432/dbname"
        />
        <button className="run" onClick={run} disabled={running}>
          {running ? "Running…" : "Run ⌘↵"}
        </button>
      </div>

      <textarea
        className="editor"
        value={sql}
        onChange={(e) => setSql(e.target.value)}
        onKeyDown={onEditorKey}
        spellCheck={false}
      />

      <div className="statusbar">
        {error ? <span className="err">{error}</span> : <span className="ok">{status}</span>}
      </div>

      <div className="results">
        {columns.length > 0 && (
          <table>
            <thead>
              <tr>
                <th className="rownum">#</th>
                {columns.map((c, i) => (
                  <th key={i}>
                    <span className="colname">{c.name}</span>
                    <span className="coltype">{c.typeName}</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, ri) => (
                <tr key={ri}>
                  <td className="rownum">{ri + 1}</td>
                  {r.map((cell, ci) => (
                    <td key={ci}>{renderCell(cell)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        )}
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
