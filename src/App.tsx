import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Channel, invoke } from "@tauri-apps/api/core";
import Editor from "./Editor";
import Grid, { type ChangeSet, type ColumnMeta, type EditableInfo } from "./Grid";
import ConnectionModal, { type Profile } from "./ConnectionModal";
import Palette, { type PaletteItem } from "./Palette";
import PlanView, { type PlanRoot } from "./PlanView";
import { splitStatements } from "./sqlStatements";
import { buildNamespace, type CatalogTable } from "./sqlNamespace";
import { toCsv, toJson } from "./export";
import { save } from "@tauri-apps/plugin-dialog";
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

type Snippet = { id: number; name: string; sql: string };

type QueryTab = {
  id: number;
  title: string;
  /** User renamed the tab — auto-titling from queries stops. */
  customTitle: boolean;
  sql: string;
  lastSql: string;
  columns: ColumnMeta[];
  rows: unknown[][];
  editable: EditableInfo | null;
  status: string;
  error: string;
  running: boolean;
  plan: PlanRoot[] | null;
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
    customTitle: false,
    sql,
    lastSql: "",
    columns: [],
    rows: [],
    editable: null,
    status: "",
    error: "",
    running: false,
    plan: null,
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
  const [catalog, setCatalog] = useState<CatalogTable[]>([]);
  const [expandedTables, setExpandedTables] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<string>("");
  const [sideTab, setSideTab] = useState<"items" | "queries" | "history">("items");
  const [snippetFilter, setSnippetFilter] = useState("");
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
    setCatalog([]);
    try {
      const info = await invoke<ConnInfo>("connect_profile", { profileId: p.id });
      setConn(info);
      setActiveProfile(p);
      setTx("none");
      setReadOnly(p.readOnly);
      setShowConnections(false);
      setObjects(await invoke<DbObject[]>("list_objects", { connId: info.connId }));
      // Autocomplete dictionary loads after the sidebar; failures are non-fatal.
      try {
        const catalog = await invoke<CatalogTable[]>("schema_catalog", { connId: info.connId });
        setCatalog(catalog);
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

  // --- session persistence: tabs restore across launches -------------------
  useEffect(() => {
    (async () => {
      try {
        const raw = await invoke<string | null>("state_get", { key: "session" });
        if (!raw) return;
        const saved = JSON.parse(raw) as {
          tabs: Pick<QueryTab, "id" | "title" | "customTitle" | "sql" | "lastSql">[];
          activeTabId: number;
          nextTabId: number;
        };
        if (!saved.tabs?.length) return;
        setTabs(
          saved.tabs.map((t) => ({
            ...blankTab(t.id, t.sql),
            title: t.title,
            customTitle: t.customTitle,
            lastSql: t.lastSql,
          })),
        );
        const ids = new Set(saved.tabs.map((t) => t.id));
        setActiveTabId(ids.has(saved.activeTabId) ? saved.activeTabId : saved.tabs[0].id);
        nextTabId.current = Math.max(saved.nextTabId ?? 0, ...saved.tabs.map((t) => t.id + 1));
      } catch {
        // A corrupt session blob should never block launch.
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const sessionTimer = useRef<number | undefined>(undefined);
  useEffect(() => {
    window.clearTimeout(sessionTimer.current);
    sessionTimer.current = window.setTimeout(() => {
      const payload = {
        tabs: tabs.map(({ id, title, customTitle, sql, lastSql }) => ({
          id,
          title,
          customTitle,
          sql,
          lastSql,
        })),
        activeTabId,
        nextTabId: nextTabId.current,
      };
      invoke("state_set", { key: "session", value: JSON.stringify(payload) }).catch(() => {});
    }, 400);
  }, [tabs, activeTabId]);

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
    (text: string, tabId?: number): Promise<boolean> => {
      if (!conn) return Promise.resolve(false);
      const id = tabId ?? activeTabIdRef.current;
      rowBuffers.current.set(id, []);
      setTabs((ts) =>
        ts.map((t) =>
          t.id === id
            ? {
                ...t,
                title: t.customTitle ? t.title : tabTitle(text, t.title),
                lastSql: text,
                columns: [],
                rows: [],
                editable: null,
                status: "",
                error: "",
                running: true,
                plan: null,
              }
            : t,
        ),
      );
      return new Promise<boolean>((resolve) => {

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
            resolve(true);
            break;
          }
          case "error":
            updateTab(id, { error: ev.message, running: false });
            if (txRef.current === "open") setTx("aborted");
            loadHistoryRef.current();
            resolve(false);
            break;
        }
      };

      invoke("run_query", { connId: conn.connId, sql: text, onEvent: channel }).catch((e) => {
        updateTab(id, { error: String(e), running: false });
        resolve(false);
      });
      });
    },
    [conn, updateTab],
  );

  /** Run a whole script: statements sequentially, stopping at the first failure. */
  const runScript = useCallback(
    async (text: string, tabId?: number) => {
      const id = tabId ?? activeTabIdRef.current;
      const stmts = splitStatements(text)
        .map((r) => text.slice(r.from, r.to).trim())
        .filter(Boolean);
      if (stmts.length === 0) return;
      if (stmts.length === 1) {
        runSql(stmts[0], id);
        return;
      }
      for (let i = 0; i < stmts.length; i++) {
        const ok = await runSql(stmts[i], id);
        if (!ok) {
          setTabs((ts) =>
            ts.map((t) =>
              t.id === id
                ? { ...t, error: `statement ${i + 1} of ${stmts.length} failed:\n\n${t.error}` }
                : t,
            ),
          );
          return;
        }
      }
      setTabs((ts) =>
        ts.map((t) =>
          t.id === id ? { ...t, status: `${stmts.length} statements — ${t.status}` } : t,
        ),
      );
    },
    [runSql],
  );

  /** EXPLAIN a statement into the tab's plan view. */
  const explainStmt = useCallback(
    async (stmt: string, tabId?: number) => {
      if (!conn) return;
      const id = tabId ?? activeTabIdRef.current;
      updateTab(id, { running: true, error: "", plan: null });
      try {
        const plan = await invoke<PlanRoot[]>("explain_query", {
          connId: conn.connId,
          sql: stmt,
          analyze: true,
        });
        updateTab(id, {
          plan,
          columns: [],
          rows: [],
          editable: null,
          status: "explain",
          running: false,
        });
      } catch (e) {
        updateTab(id, { error: String(e), running: false });
      }
    },
    [conn, updateTab],
  );

  const run = useCallback(() => runScript(activeTab.sql), [runScript, activeTab.sql]);

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

  const [tx, setTx] = useState<"none" | "open" | "aborted">("none");
  const txRef = useRef(tx);
  txRef.current = tx;
  const [readOnly, setReadOnly] = useState(false);
  const [snippets, setSnippets] = useState<Snippet[]>([]);
  const [showPalette, setShowPalette] = useState(false);
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;

  const loadSnippets = useCallback(async () => {
    try {
      setSnippets(await invoke<Snippet[]>("snippet_list"));
    } catch {
      // non-critical
    }
  }, []);
  useEffect(() => {
    loadSnippets();
  }, [loadSnippets]);

  const execSimple = useCallback(
    async (sql: string) => {
      if (!conn) throw new Error("not connected");
      await invoke("exec_simple", { connId: conn.connId, sql });
    },
    [conn],
  );

  const txAction = useCallback(
    async (action: "begin" | "commit" | "rollback") => {
      try {
        await execSimple(action);
        setTx(action === "begin" ? "open" : "none");
      } catch {
        // Failed tx control: reflect reality as best we can.
        if (action !== "begin") setTx("none");
      }
    },
    [execSimple],
  );

  const toggleReadOnly = useCallback(async () => {
    const next = !readOnly;
    try {
      await execSimple(`set default_transaction_read_only = ${next ? "on" : "off"}`);
      setReadOnly(next);
    } catch {
      // surfaced on next query if the session is dead
    }
  }, [execSimple, readOnly]);

  const [renaming, setRenaming] = useState<{ id: number; text: string } | null>(null);
  const [dragTabId, setDragTabId] = useState<number | null>(null);

  const commitRename = useCallback(() => {
    if (!renaming) return;
    const text = renaming.text.trim();
    setTabs((ts) =>
      ts.map((t) => {
        if (t.id !== renaming.id) return t;
        // Empty name reverts to auto-titling.
        return text
          ? { ...t, title: text, customTitle: true }
          : {
              ...t,
              title: tabTitle(t.lastSql || t.sql, `Query ${t.id}`),
              customTitle: false,
            };
      }),
    );
    setRenaming(null);
  }, [renaming]);

  /** Live-reorder while dragging: move the dragged tab to the hovered slot. */
  const moveTab = useCallback((fromId: number, toId: number) => {
    setTabs((ts) => {
      const from = ts.findIndex((t) => t.id === fromId);
      const to = ts.findIndex((t) => t.id === toId);
      if (from < 0 || to < 0 || from === to) return ts;
      const next = [...ts];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });
  }, []);

  // Pointer-based tab dragging. HTML5 DnD is a dead end here: WebKit aborts
  // the drag session as soon as the live reorder moves the dragged node.
  const startTabDrag = useCallback(
    (e: React.MouseEvent, id: number) => {
      if (e.button !== 0 || renaming) return;
      const startX = e.clientX;
      let started = false;
      const move = (ev: MouseEvent) => {
        if (!started) {
          if (Math.abs(ev.clientX - startX) < 5) return;
          started = true;
          setDragTabId(id);
          document.body.classList.add("row-resizing"); // reuse the no-select rule
        }
        const els = document.querySelectorAll<HTMLElement>(".tab-bar .tab");
        for (const el of els) {
          const r = el.getBoundingClientRect();
          if (ev.clientX >= r.left && ev.clientX <= r.right) {
            const overId = Number(el.dataset.tabid);
            if (overId !== id) moveTab(id, overId);
            break;
          }
        }
      };
      const up = () => {
        window.removeEventListener("mousemove", move);
        window.removeEventListener("mouseup", up);
        document.body.classList.remove("row-resizing");
        setDragTabId(null);
      };
      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", up);
    },
    [moveTab, renaming],
  );

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
      } else if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setShowPalette((v) => !v);
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

  const columnsByTable = useMemo(() => {
    const m = new Map<string, CatalogTable>();
    for (const t of catalog) m.set(`${t.schema}.${t.name}`, t);
    return m;
  }, [catalog]);

  const toggleTableExpand = (key: string) =>
    setExpandedTables((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  /** Export a tab's result set through the native save dialog. */
  const exportTab = useCallback(async (tabId: number, format: "csv" | "json") => {
    const t = tabsRef.current.find((x) => x.id === tabId);
    if (!t || t.columns.length === 0) return;
    const base = (t.editable?.table ?? t.title.replace(/\W+/g, "_") ?? "results").toLowerCase();
    const path = await save({
      defaultPath: `${base}.${format}`,
      filters: [{ name: format.toUpperCase(), extensions: [format] }],
    });
    if (!path) return;
    const contents = format === "csv" ? toCsv(t.columns, t.rows) : toJson(t.columns, t.rows);
    try {
      await invoke("write_file", { path, contents });
      updateTab(tabId, { status: `exported ${t.rows.length.toLocaleString()} rows → ${path.split("/").pop()}` });
    } catch (e) {
      updateTab(tabId, { error: String(e) });
    }
  }, [updateTab]);

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

  const paletteItems = useMemo<PaletteItem[]>(() => {
    const items: PaletteItem[] = [
      { id: "new-tab", label: "New tab", group: "cmd", hint: "⌘T", run: () => addTab() },
      {
        id: "run-all",
        label: "Run all statements",
        group: "cmd",
        hint: "⌘⇧↵",
        run: () => runScript(tabsRef.current.find((t) => t.id === activeTabIdRef.current)?.sql ?? ""),
      },
      {
        id: "explain",
        label: "Explain first statement",
        group: "cmd",
        hint: "⌘E",
        run: () => {
          const sql = tabsRef.current.find((t) => t.id === activeTabIdRef.current)?.sql ?? "";
          const r = splitStatements(sql)[0];
          if (r) explainStmt(sql.slice(r.from, r.to).trim());
        },
      },
      { id: "connections", label: "Connections…", group: "cmd", run: () => setShowConnections(true) },
      {
        id: "reconnect",
        label: "Reconnect",
        group: "cmd",
        run: () => activeProfile && connectProfile(activeProfile).catch(() => {}),
      },
      {
        id: "toggle-ro",
        label: readOnly ? "Disable read-only session" : "Make session read-only",
        group: "cmd",
        run: () => toggleReadOnly(),
      },
      {
        id: "snippet-save",
        label: "Save current SQL as snippet…",
        group: "snippet",
        prompt: {
          placeholder: "Snippet name…",
          submit: async (name) => {
            const sql = tabsRef.current.find((t) => t.id === activeTabIdRef.current)?.sql ?? "";
            try {
              await invoke("snippet_save", { name, sql });
              await loadSnippets();
            } catch {
              // palette is closed by now; failure just means no new snippet
            }
          },
        },
      },
    ];
    items.push(
      {
        id: "export-csv",
        label: "Export results as CSV",
        group: "cmd",
        run: () => exportTab(activeTabIdRef.current, "csv"),
      },
      {
        id: "export-json",
        label: "Export results as JSON",
        group: "cmd",
        run: () => exportTab(activeTabIdRef.current, "json"),
      },
    );
    if (tx === "none") {
      items.push({ id: "begin", label: "Begin transaction", group: "cmd", run: () => txAction("begin") });
    } else {
      items.push(
        { id: "commit", label: "Commit transaction", group: "cmd", run: () => txAction("commit") },
        { id: "rollback", label: "Rollback transaction", group: "cmd", run: () => txAction("rollback") },
      );
    }
    for (const o of objects) {
      items.push({
        id: `open:${o.schema}.${o.name}`,
        label: `Open ${o.schema}.${o.name}`,
        group: o.kind,
        run: () => openObject(o),
      });
    }
    for (const sn of snippets) {
      items.push({
        id: `snippet:${sn.id}`,
        label: `Snippet: ${sn.name}`,
        group: "snippet",
        run: () => {
          const active = tabsRef.current.find((t) => t.id === activeTabIdRef.current);
          if (active && !active.sql.trim()) updateTab(active.id, { sql: sn.sql });
          else addTab(sn.sql);
        },
      });
      items.push({
        id: `snippet-del:${sn.id}`,
        label: `Delete snippet: ${sn.name}`,
        group: "snippet",
        run: async () => {
          try {
            await invoke("snippet_delete", { snippetId: sn.id });
            await loadSnippets();
          } catch {
            // non-critical
          }
        },
      });
    }
    return items;
  }, [
    addTab,
    runScript,
    explainStmt,
    activeProfile,
    connectProfile,
    readOnly,
    toggleReadOnly,
    tx,
    txAction,
    objects,
    snippets,
    openObject,
    updateTab,
    loadSnippets,
    exportTab,
  ]);

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
        <button
          className={`btn lock ${readOnly ? "on" : ""}`}
          onClick={toggleReadOnly}
          disabled={!conn}
          title={readOnly ? "Session is read-only — click to allow writes" : "Make session read-only"}
        >
          {readOnly ? "🔒" : "🔓"}
        </button>
        <button
          className="btn"
          onClick={() => {
            const stmts = splitStatements(activeTab.sql);
            if (stmts.length) {
              explainStmt(activeTab.sql.slice(stmts[0].from, stmts[0].to).trim());
            }
          }}
          disabled={!conn || activeTab.running}
          title="Explain (⌘E) — analyze runs selects only, writes are planned without executing"
        >
          Explain
        </button>
        {activeTab.running ? (
          <button className="btn stop" onClick={stop} title="Cancel query">
            ■ Stop
          </button>
        ) : (
          <button className="btn run" onClick={run} disabled={!conn} title="Run all (⌘⇧↵)">
            ▶ Run
          </button>
        )}
      </div>

      {/* The banner doubles as a window drag handle — it's the natural grab spot. */}
      <div className={`conn-banner ${bannerColor}`} data-tauri-drag-region>
        {banner}
      </div>

      {showPalette && <Palette items={paletteItems} onClose={() => setShowPalette(false)} />}

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
              className={sideTab === "queries" ? "active" : ""}
              onClick={() => setSideTab("queries")}
            >
              Queries
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
                        const cols = columnsByTable.get(key)?.columns;
                        const expanded = expandedTables.has(key);
                        return (
                          <div key={key}>
                            <div
                              className={`item-row ${selected === key ? "selected" : ""}`}
                              onClick={() => openObject(o)}
                              title={`${o.kind} ${key}`}
                            >
                              <span
                                className="item-chevron"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  toggleTableExpand(key);
                                }}
                              >
                                {cols?.length ? (expanded ? "⌄" : "›") : ""}
                              </span>
                              <span className={`obj-icon ${o.kind}`}>
                                {KIND_ICON[o.kind] ?? "▦"}
                              </span>
                              {o.name}
                            </div>
                            {expanded &&
                              cols?.map((c) => (
                                <div key={c.name} className="col-row" title={`${c.name} ${c.dataType}`}>
                                  <span className="col-name">{c.name}</span>
                                  <span className="col-type">{c.dataType}</span>
                                </div>
                              ))}
                          </div>
                        );
                      })}
                  </div>
                ))}
              </div>
            </>
          ) : sideTab === "queries" ? (
            <>
              <input
                className="filter"
                value={snippetFilter}
                onChange={(e) => setSnippetFilter(e.target.value)}
                placeholder="Search saved queries…"
                spellCheck={false}
              />
              <div className="tree">
                {snippets.length === 0 && (
                  <div className="tree-empty">
                    No saved queries yet — ⌘K → "Save current SQL as snippet…"
                  </div>
                )}
                {snippets
                  .filter((sn) => sn.name.toLowerCase().includes(snippetFilter.trim().toLowerCase()))
                  .map((sn) => (
                    <div
                      key={sn.id}
                      className="hist-row snip-row"
                      onClick={() => {
                        const active = tabsRef.current.find((t) => t.id === activeTabIdRef.current);
                        if (active && !active.sql.trim()) updateTab(active.id, { sql: sn.sql });
                        else addTab(sn.sql);
                      }}
                      title={sn.sql}
                    >
                      <div className="snip-head">
                        <span className="snip-name">{sn.name}</span>
                        <button
                          className="snip-del"
                          title="Delete saved query"
                          onClick={async (e) => {
                            e.stopPropagation();
                            try {
                              await invoke("snippet_delete", { snippetId: sn.id });
                              await loadSnippets();
                            } catch {
                              // non-critical
                            }
                          }}
                        >
                          ×
                        </button>
                      </div>
                      <div className="hist-sql">{sn.sql}</div>
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
                className={`tab ${t.id === activeTabId ? "active" : ""} ${
                  t.id === dragTabId ? "dragging" : ""
                }`}
                data-tabid={t.id}
                onClick={() => setActiveTabId(t.id)}
                onDoubleClick={() => setRenaming({ id: t.id, text: t.title })}
                onMouseDown={(e) => startTabDrag(e, t.id)}
                title={t.lastSql || t.sql}
              >
                {t.running && <span className="tab-spinner">●</span>}
                {renaming?.id === t.id ? (
                  <input
                    className="tab-rename"
                    autoFocus
                    value={renaming.text}
                    onChange={(e) => setRenaming({ id: t.id, text: e.target.value })}
                    onBlur={commitRename}
                    onKeyDown={(e) => {
                      e.stopPropagation();
                      if (e.key === "Enter") commitRename();
                      else if (e.key === "Escape") setRenaming(null);
                    }}
                    onClick={(e) => e.stopPropagation()}
                    onDoubleClick={(e) => e.stopPropagation()}
                    spellCheck={false}
                  />
                ) : (
                  <span className="tab-title">{t.title}</span>
                )}
                {tabs.length > 1 && renaming?.id !== t.id && (
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
              onRunAll={runScript}
              onExplain={explainStmt}
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
              ) : t.plan ? (
                <PlanView roots={t.plan} />
              ) : (
                t.columns.length > 0 && (
                  <Grid
                    columns={t.columns}
                    rows={t.rows}
                    editable={readOnly ? null : t.editable}
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
                    onExport={(format) => exportTab(t.id, format)}
                  />
                )
              )}
            </div>
          ))}

          <div className="statusbar">
            <span className="hint">
              {tx === "none" && (
                <button className="btn mini" disabled={!conn} onClick={() => txAction("begin")}>
                  Begin
                </button>
              )}
              {tx !== "none" && (
                <>
                  <span className={`tx-state ${tx}`}>
                    {tx === "open" ? "in transaction" : "transaction aborted"}
                  </span>
                  {tx === "open" && (
                    <button className="btn mini" onClick={() => txAction("commit")}>
                      Commit
                    </button>
                  )}
                  <button className="btn mini danger" onClick={() => txAction("rollback")}>
                    Rollback
                  </button>
                </>
              )}
              <span className="hint-sep">·</span>⌘↵ stmt · ⌘⇧↵ all · ⌘K palette
              {readOnly
                ? " · read-only session"
                : activeTab.columns.length > 0 &&
                  (activeTab.editable ? " · editable" : " · read-only")}
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
