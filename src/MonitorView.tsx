import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

type ActivityRow = {
  pid: number;
  user: string | null;
  database: string | null;
  app: string | null;
  client: string | null;
  state: string | null;
  wait: string | null;
  queryStartMs: number | null;
  xactStartMs: number | null;
  query: string | null;
  backendType: string | null;
};

function fmtDuration(ms: number): string {
  const s = ms / 1000;
  if (s < 1) return "<1s";
  if (s < 60) return `${s.toFixed(0)}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${Math.floor(s % 60)}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

function stateClass(state: string | null): string {
  if (state === "active") return "act-active";
  if (state === "idle in transaction" || state === "idle in transaction (aborted)")
    return "act-idletx";
  return "act-idle";
}

export default function MonitorView({ connId }: { connId: number }) {
  const [rows, setRows] = useState<ActivityRow[]>([]);
  const [paused, setPaused] = useState(false);
  const [error, setError] = useState("");
  const [now, setNow] = useState(Date.now());
  const timer = useRef<number | undefined>(undefined);

  const refresh = useCallback(async () => {
    try {
      setRows(await invoke<ActivityRow[]>("activity_list", { connId }));
      setError("");
      setNow(Date.now());
    } catch (e) {
      setError(String(e));
    }
  }, [connId]);

  useEffect(() => {
    refresh();
    if (paused) return;
    timer.current = window.setInterval(refresh, 2000);
    return () => window.clearInterval(timer.current);
  }, [refresh, paused]);

  const kill = async (pid: number, terminate: boolean) => {
    if (terminate && !window.confirm(`Terminate backend ${pid}? Its session dies entirely.`))
      return;
    try {
      await invoke("kill_backend", { connId, pid, terminate });
      refresh();
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <div className="monitor-view">
      <div className="monitor-toolbar">
        <span className="structure-title">pg_stat_activity</span>
        <span className="ai-ctx-sub">
          {rows.length} session{rows.length === 1 ? "" : "s"} · refreshes every 2s
        </span>
        <span className="spacer" />
        <button className="btn mini" onClick={() => setPaused((p) => !p)}>
          {paused ? "▶ Resume" : "❚❚ Pause"}
        </button>
      </div>
      {error && <div className="modal-err">{error}</div>}
      <table className="monitor-table">
        <thead>
          <tr>
            <th>pid</th>
            <th>user</th>
            <th>db</th>
            <th>app</th>
            <th>state</th>
            <th>wait</th>
            <th>running</th>
            <th>query</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.pid}>
              <td className="st-name">{r.pid}</td>
              <td>{r.user ?? ""}</td>
              <td>{r.database ?? ""}</td>
              <td className="mon-app">{r.app ?? ""}</td>
              <td>
                <span className={`act-badge ${stateClass(r.state)}`}>{r.state ?? "—"}</span>
              </td>
              <td>{r.wait ?? ""}</td>
              <td className="mon-dur">
                {r.state === "active" && r.queryStartMs
                  ? fmtDuration(now - r.queryStartMs)
                  : ""}
              </td>
              <td className="mon-query" title={r.query ?? ""}>
                {r.query ?? ""}
              </td>
              <td className="mon-actions">
                <button className="btn mini" title="pg_cancel_backend — interrupt the query" onClick={() => kill(r.pid, false)}>
                  cancel
                </button>
                <button className="btn mini danger" title="pg_terminate_backend — kill the session" onClick={() => kill(r.pid, true)}>
                  kill
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
