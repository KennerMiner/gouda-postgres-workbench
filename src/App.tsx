import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Channel, invoke } from "@tauri-apps/api/core";
import Editor from "./Editor";
import Grid, { type ChangeSet, type ColumnMeta, type EditableInfo } from "./Grid";
import ConnectionModal, { type Profile } from "./ConnectionModal";
import { buildNamespace, type CatalogTable } from "./sqlNamespace";
import type { SQLNamespace } from "@codemirror/lang-sql";
import "./App.css";

type QueryEvent =
  | { kind: "meta"; columns: ColumnMeta[]; editable: EditableInfo | null }
  | { kind: "rows"; rows: unknown[][] }
  | { kind: "done"; rowCount: number; elapsedMs: number }
  | { kind: "error"; message: string };

type ConnInfo = { connId: number; serverVersion: string; user: string; database: string };
type DbObject = { schema: string; name: string; kind: string };
type HistoryEntry = {
  id: number;
  connLabel: string;
  sql: string;
  startedAt: number;
  elapsedMs: number | null;
  rowCount: number | null;
  error: string | null;
};

type QueryTab = {
  id: number;
  title: string;
  sql: string;
  lastSql: string;
  columns: ColumnMeta[];
  rows: unknown[][];
  editable: EditableInfo | null;
  status: string;
  error: string;
  running: boolean;
};

const DEFAULT_SQL =
  "select table_name, table_type from information_schema.tables where table_schema = 'public' order by 1;";

const KIND_ICON: Record<string, string> = {
  table: "▦",
  view: "▤",
  matview: "▥",
  foreign: "▧",
};

/** Quote an identifier for interpolation into generated SQL. */
function qi(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function timeAgo(ms: number): string {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/** Tab title from the query's main target table, else a generic name. */
function tabTitle(sql: string, fallback: string): string {
  const m = /(?:from|into|update|table)\s+([\w".]+)/i.exec(sql);
  if (!m) return fallback;
  return m[1].replace(/"/g, "").split(".").pop() || fallback;
}

function blankTab(id: number, sql = ""): QueryTab {
  return {
    id,
    title: `Query ${id}`,
    sql,
    lastSql: "",
    columns: [],
    rows: [],
    editable: null,
    status: "",
    error: "",
    running: false,
  };
}

function App() {
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [activeProfile, setActiveProfile] = useState<Profile | null>(null);
  const [showConnections, setShowConnections] = useState(false);
  const [conn, setConn] = useState<ConnInfo | null>(null);
  const [connError, setConnError] = useState("");
  const [objects, setObjects] = useState<DbObject[]>([]);
  const [schemaNs, setSchemaNs] = useState<SQLNamespace | null>(null);
  const [filter, setFilter] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<string>("");
  const [sideTab, setSideTab] = useState<"items" | "history">("items");
  const [historyEntries, setHistoryEntries] = useState<HistoryEntry[]>([]);
  const [historyFilter, setHistoryFilter] = useState("");

  const [tabs, setTabs] = useState<QueryTab[]>([blankTab(1, DEFAULT_SQL)]);
  const [activeTabId, setActiveTabId] = useState(1);
  const nextTabId = useRef(2);
  const [editorH, setEditorH] = useState(160);
  // Per-tab row accumulation buffers for streaming results.
  const rowBuffers = useRef(new Map<number, unknown[][]>());

  const activeTab = tabs.find((t) => t.id === activeTabId) ?? tabs[0];
  const activeTabIdRef = useRef(activeTabId);
  activeTabIdRef.current = activeTabId;

  const updateTab = useCallback((id: number, patch: Partial<QueryTab>) => {
    setTabs((ts) => ts.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  }, []);

  const refreshProfiles = useCallback(async () => {
    const list = await invoke<Profile[]>("profiles_list");
    setProfiles(list);
    return list;
  }, []);

  const connectProfile = useCallback(async (p: Profile) => {
    setConnError("");
    setConn(null);
    setObjects([]);
    setSchemaNs(null);
    try {
      const info = await invoke<ConnInfo>("connect_profile", { profileId: p.id });
      setConn(info);
      setActiveProfile(p);
      setShowConnections(false);
      setObjects(await invoke<DbObject[]>("list_objects", { connId: info.connId }));
      // Autocomplete dictionary loads after the sidebar; failures are non-fatal.
      try {
        const catalog = await invoke<CatalogTable[]>("schema_catalog", { connId: info.connId });
        setSchemaNs(buildNamespace(catalog));
      } catch {
        // completions just stay keyword-only
      }
    } catch (e) {
      setConnError(String(e));
      throw e;
    }
  }, []);

  const saveProfile = useCallback(
    async (p: Profile, password: string | null): Promise<Profile> => {
      const id = await invoke<number>("profile_save", { profile: p, password });
      await refreshProfiles();
      return { ...p, id };
    },
    [refreshProfiles],
  );

  const deleteProfile = useCallback(
    async (profileId: number) => {
      await invoke("profile_delete", { profileId });
      await refreshProfiles();
    },
    [refreshProfiles],
  );

  const testProfile = useCallback(
    (p: Profile, password: string | null) =>
      invoke<string>("test_connection", { profile: p, password }),
    [],
  );

  // Daily-driver behavior: connect to the most recently used profile on launch.
  useEffect(() => {
    (async () => {
      try {
        const list = await refreshProfiles();
        if (list.length > 0) await connectProfile(list[0]);
        else setShowConnections(true);
      } catch {
        // Connect error already surfaced via connError.
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadHistory = useCallback(async () => {
    try {
      setHistoryEntries(
        await invoke<HistoryEntry[]>("history_list", {
          search: historyFilter.trim() || null,
          limit: 200,
        }),
      );
    } catch {
      // History is non-critical; ignore load failures.
    }
  }, [historyFilter]);
  const loadHistoryRef = useRef(loadHistory);
  loadHistoryRef.current = loadHistory;

  useEffect(() => {
    if (sideTab === "history") loadHistory();
  }, [sideTab, loadHistory]);

  const runSql = useCallback(
    async (text: string, tabId?: number) => {
      if (!conn) return;
      const id = tabId ?? activeTabIdRef.current;
      rowBuffers.current.set(id, []);
      setTabs((ts) =>
        ts.map((t) =>
          t.id === id
            ? {
                ...t,
                title: tabTitle(text, t.title),
                lastSql: text,
                columns: [],
                rows: [],
                editable: null,
                status: "",
                error: "",
                running: true,
              }
            : t,
        ),
      );

      const channel = new Channel<QueryEvent>();
      channel.onmessage = (ev) => {
        switch (ev.kind) {
          case "meta":
            updateTab(id, { columns: ev.columns, editable: ev.editable ?? null });
            break;
          case "rows": {
            // Accumulate in a ref and hand React the same concatenated array
            // so each batch is one rerender, not one per row.
            const buf = (rowBuffers.current.get(id) ?? []).concat(ev.rows);
            rowBuffers.current.set(id, buf);
            updateTab(id, { rows: buf });
            break;
          }
          case "done": {
            // Defensive: a field mismatch from the backend must never kill
            // the rest of the handler (learned the hard way — see git log).
            const n = ev.rowCount ?? 0;
            updateTab(id, {
              status: `${n.toLocaleString()} row${n === 1 ? "" : "s"} in ${ev.elapsedMs ?? "?"} ms`,
              running: false,
            });
            loadHistoryRef.current();
            break;
          }
          case "error":
            updateTab(id, { error: ev.message, running: false });
            loadHistoryRef.current();
            break;
        }
      };

      try {
        await invoke("run_query", { connId: conn.connId, sql: text, onEvent: channel });
      } catch (e) {
        updateTab(id, { error: String(e), running: false });
      }
    },
    [conn, updateTab],
  );

  const run = useCallback(() => runSql(activeTab.sql), [runSql, activeTab.sql]);

  const stop = useCallback(async () => {
    if (!conn) return;
    try {
      await invoke("cancel_query", { connId: conn.connId });
    } catch {
      // Cancellation is best-effort; the running query surfaces the error.
    }
  }, [conn]);

  const addTab = useCallback((sql = "") => {
    const id = nextTabId.current++;
    setTabs((ts) => [...ts, blankTab(id, sql)]);
    setActiveTabId(id);
    return id;
  }, []);

  const closeTab = useCallback(
    (id: number) => {
      setTabs((ts) => {
        if (ts.length === 1) return ts; // always keep one tab
        const idx = ts.findIndex((t) => t.id === id);
        const next = ts.filter((t) => t.id !== id);
        if (id === activeTabIdRef.current) {
          setActiveTabId(next[Math.max(0, idx - 1)].id);
        }
        rowBuffers.current.delete(id);
        return next;
      });
    },
    [],
  );

  // ⌘T = new tab (⌘W stays "close window" — the tab bar × closes tabs).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key === "t") {
        e.preventDefault();
        addTab();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [addTab]);

  const openObject = useCallback(
    (o: DbObject) => {
      const key = `${o.schema}.${o.name}`;
      setSelected(key);
      const text = `select * from ${qi(o.schema)}.${qi(o.name)} limit 500;`;
      updateTab(activeTabIdRef.current, { sql: text });
      runSql(text);
    },
    [runSql, updateTab],
  );

  const schemas = useMemo(() => {
    const f = filter.trim().toLowerCase();
    const visible = f ? objects.filter((o) => o.name.toLowerCase().includes(f)) : objects;
    const bySchema = new Map<string, DbObject[]>();
    for (const o of visible) {
      const list = bySchema.get(o.schema) ?? [];
      list.push(o);
      bySchema.set(o.schema, list);
    }
    return [...bySchema.entries()];
  }, [objects, filter]);

  const startSplitDrag = (e: React.MouseEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = editorH;
    const move = (ev: MouseEvent) => {
      const max = window.innerHeight - 220; // keep the results pane usable
      setEditorH(Math.max(60, Math.min(max, startH + ev.clientY - startY)));
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      document.body.classList.remove("row-resizing");
    };
    document.body.classList.add("row-resizing");
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  const toggleSchema = (s: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      return next;
    });

  const banner = conn
    ? `PostgreSQL ${conn.serverVersion} : ${conn.user} : ${activeProfile?.host ?? "?"} : ${conn.database}`
    : connError
      ? "not connected"
      : "connecting…";
  const bannerColor = conn && activeProfile ? `c-${activeProfile.color}` : "disconnected";

  return (
    <div className="app">
      <div className="titlebar" data-tauri-drag-region>
        <button className="conn-pill" onClick={() => setShowConnections(true)} title="Connections">
          <span className={`dot c-${activeProfile?.color ?? "green"}`} />
          {activeProfile?.name ?? "No connection"}
        </button>
        {activeProfile && (
          <button
            className="btn"
            onClick={() => connectProfile(activeProfile).catch(() => {})}
            title="Reconnect"
          >
            ↻
          </button>
        )}
        <span className="titlebar-space" data-tauri-drag-region />
        {activeTab.running ? (
          <button className="btn stop" onClick={stop} title="Cancel query">
            ■ Stop
          </button>
        ) : (
          <button className="btn run" onClick={run} disabled={!conn} title="Run (⌘↵)">
            ▶ Run
          </button>
        )}
      </div>

      {/* The banner doubles as a window drag handle — it's the natural grab spot. */}
      <div className={`conn-banner ${bannerColor}`} data-tauri-drag-region>
        {banner}
      </div>

      {showConnections && (
        <ConnectionModal
          profiles={profiles}
          activeId={conn ? (activeProfile?.id ?? null) : null}
          onSave={saveProfile}
          onDelete={deleteProfile}
          onConnect={connectProfile}
          onTest={testProfile}
          onClose={() => setShowConnections(false)}
        />
      )}

      <div className="body">
        <div className="sidebar">
          <div className="side-tabs">
            <button
              className={sideTab === "items" ? "active" : ""}
              onClick={() => setSideTab("items")}
            >
              Items
            </button>
            <button
              className={sideTab === "history" ? "active" : ""}
              onClick={() => setSideTab("history")}
            >
              History
            </button>
          </div>

          {sideTab === "items" ? (
            <>
              <input
                className="filter"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="Search for item…"
                spellCheck={false}
              />
              <div className="tree">
                {connError && <div className="tree-error">{connError}</div>}
                {schemas.map(([schema, items]) => (
                  <div key={schema}>
                    <div className="schema-row" onClick={() => toggleSchema(schema)}>
                      <span className="chevron">{collapsed.has(schema) ? "›" : "⌄"}</span>
                      {schema}
                      <span className="count">{items.length}</span>
                    </div>
                    {!collapsed.has(schema) &&
                      items.map((o) => {
                        const key = `${o.schema}.${o.name}`;
                        return (
                          <div
                            key={key}
                            className={`item-row ${selected === key ? "selected" : ""}`}
                            onClick={() => openObject(o)}
                            title={`${o.kind} ${key}`}
                          >
                            <span className={`obj-icon ${o.kind}`}>
                              {KIND_ICON[o.kind] ?? "▦"}
                            </span>
                            {o.name}
                          </div>
                        );
                      })}
                  </div>
                ))}
              </div>
            </>
          ) : (
            <>
              <input
                className="filter"
                value={historyFilter}
                onChange={(e) => setHistoryFilter(e.target.value)}
                placeholder="Search history…"
                spellCheck={false}
              />
              <div className="tree">
                {historyEntries.length === 0 && <div className="tree-empty">No queries yet</div>}
                {historyEntries.map((h) => (
                  <div
                    key={h.id}
                    className="hist-row"
                    onClick={() => updateTab(activeTabIdRef.current, { sql: h.sql })}
                    title={h.error ?? h.sql}
                  >
                    <div className={`hist-sql ${h.error ? "failed" : ""}`}>{h.sql}</div>
                    <div className="hist-meta">
                      {timeAgo(h.startedAt)}
                      {h.error
                        ? " · failed"
                        : h.rowCount !== null
                          ? ` · ${h.rowCount.toLocaleString()} rows`
                          : ""}
                      {h.elapsedMs !== null ? ` · ${h.elapsedMs} ms` : ""}
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>

        <div className="main">
          <div className="tab-bar">
            {tabs.map((t) => (
              <div
                key={t.id}
                className={`tab ${t.id === activeTabId ? "active" : ""}`}
                onClick={() => setActiveTabId(t.id)}
                title={t.lastSql || t.sql}
              >
                {t.running && <span className="tab-spinner">●</span>}
                <span className="tab-title">{t.title}</span>
                {tabs.length > 1 && (
                  <span
                    className="tab-close"
                    onClick={(e) => {
                      e.stopPropagation();
                      closeTab(t.id);
                    }}
                    title="Close tab"
                  >
                    ×
                  </span>
                )}
              </div>
            ))}
            <button className="tab-add" onClick={() => addTab()} title="New tab (⌘T)">
              +
            </button>
          </div>

          <div className="editor-pane" style={{ height: editorH }}>
            <Editor
              tabId={activeTabId}
              value={activeTab.sql}
              onChange={(text) => updateTab(activeTabIdRef.current, { sql: text })}
              onRun={runSql}
              schema={schemaNs}
            />
          </div>

          <div className="splitter" onMouseDown={startSplitDrag} />

          {/* One results pane per tab, hidden when inactive, so staged edits,
              selection, and scroll position survive tab switches. */}
          {tabs.map((t) => (
            <div
              key={t.id}
              className="results"
              style={t.id === activeTabId ? undefined : { display: "none" }}
            >
              {t.error ? (
                <div className="error-pane">{t.error}</div>
              ) : (
                t.columns.length > 0 && (
                  <Grid
                    columns={t.columns}
                    rows={t.rows}
                    editable={t.editable}
                    applyChanges={(schema, table, changes: ChangeSet, dryRun) =>
                      invoke<string[]>("apply_changes", {
                        connId: conn?.connId ?? 0,
                        schema,
                        table,
                        changes,
                        dryRun,
                      })
                    }
                    refresh={() => {
                      if (t.lastSql) runSql(t.lastSql, t.id);
                    }}
                  />
                )
              )}
            </div>
          ))}

          <div className="statusbar">
            <span className="hint">
              Run statement: ⌘↵
              {activeTab.columns.length > 0 && (activeTab.editable ? " · editable" : " · read-only")}
            </span>
            <span className="rowcount">{activeTab.running ? "running…" : activeTab.status}</span>
            <span className="engine">
              {conn ? `PostgreSQL ${conn.serverVersion}` : "disconnected"}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

export default App;
