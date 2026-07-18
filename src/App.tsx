import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Channel, invoke } from "@tauri-apps/api/core";
import Editor from "./Editor";
import Grid, { type ChangeSet, type ColumnMeta, type EditableInfo } from "./Grid";
import ConnectionModal, { type Profile } from "./ConnectionModal";
import Palette, { type PaletteItem } from "./Palette";
import AiContextModal from "./AiContextModal";
import PlanView, { type PlanRoot } from "./PlanView";
import StructureView, { type TableStructure } from "./StructureView";
import MonitorView from "./MonitorView";
import NotifyView from "./NotifyView";
import ERView from "./ERView";
import DiffView from "./DiffView";
import { splitStatements } from "./sqlStatements";
import { buildNamespace, type CatalogTable } from "./sqlNamespace";
import { META_HELP, SERVER_QUERIES, translateMeta } from "./metaCommands";
import { confirmDangerous } from "./sqlSafety";
import { save } from "@tauri-apps/plugin-dialog";
import type { SQLNamespace } from "@codemirror/lang-sql";
import { getCurrentWindow } from "@tauri-apps/api/window";
import "./App.css";

type QueryEvent =
  | { kind: "meta"; columns: ColumnMeta[]; editable: EditableInfo | null }
  | { kind: "rows"; rows: unknown[][] }
  | { kind: "done"; rowCount: number; elapsedMs: number; truncated?: boolean }
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
  structure: TableStructure | null;
  structureTitle: string;
  notice: string;
  special: "monitor" | "notify" | "er" | "diff" | null;
  tx: "none" | "open" | "aborted";
};

// Each window persists its own tab session.
const WIN_LABEL = getCurrentWindow().label;
const SESSION_KEY = WIN_LABEL === "main" ? "session" : `session:${WIN_LABEL}`;

// How this window was opened (set by open_new_window's URL query):
//   ?profile=<id> → connect to that profile ("same connection", ⌘⇧N)
//   ?connect=none → open blank, show connection manager ("no connection", ⌘N)
const LAUNCH_PARAMS = new URLSearchParams(window.location.search);
const LAUNCH_PROFILE_ID = Number(LAUNCH_PARAMS.get("profile")) || null;
const LAUNCH_NO_CONNECT = LAUNCH_PARAMS.get("connect") === "none";

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
    structure: null,
    structureTitle: "",
    notice: "",
    special: null,
    tx: "none",
  };
}

function App() {
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [activeProfile, setActiveProfile] = useState<Profile | null>(null);
  const activeProfileRef = useRef<Profile | null>(null);
  const [showConnections, setShowConnections] = useState(false);
  const [connError, setConnError] = useState("");
  const [objects, setObjects] = useState<DbObject[]>([]);
  const objectsRef = useRef<DbObject[]>([]);
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
  const [conn, setConn] = useState<ConnInfo | null>(null);
  const connRef = useRef(conn);
  connRef.current = conn;

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
      activeProfileRef.current = p;
      setTabs((ts) => ts.map((t) => ({ ...t, tx: "none" })));
      setReadOnly(p.readOnly);
      setShowConnections(false);
      const objs = await invoke<DbObject[]>("list_objects", { connId: info.connId });
      setObjects(objs);
      objectsRef.current = objs;
      // Autocomplete dictionary loads after the sidebar; failures are non-fatal.
      try {
        const catalog = await invoke<CatalogTable[]>("schema_catalog", { connId: info.connId });
        setCatalog(catalog);
        setSchemaNs(buildNamespace(catalog));
      } catch {
        // completions just stay keyword-only
      }
      return info;
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

  // Launch behavior. Default (and the main window): connect to the most
  // recently used profile. A window opened with ⌘N asks for no connection;
  // one opened with ⌘⇧N asks for a specific profile ("same connection").
  useEffect(() => {
    (async () => {
      try {
        const list = await refreshProfiles();
        if (LAUNCH_NO_CONNECT) {
          setShowConnections(true);
          return;
        }
        const target = LAUNCH_PROFILE_ID
          ? list.find((p) => p.id === LAUNCH_PROFILE_ID)
          : list[0];
        if (target) await connectProfile(target);
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
        const raw = await invoke<string | null>("state_get", { key: SESSION_KEY });
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
      invoke("state_set", { key: SESSION_KEY, value: JSON.stringify(payload) }).catch(() => {});
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
    (
      text: string,
      tabId?: number,
      opts?: { retried?: boolean; connId?: number },
    ): Promise<boolean> => {
      const connId = opts?.connId ?? connRef.current?.connId;
      if (!connId) return Promise.resolve(false);
      const id = tabId ?? activeTabIdRef.current;

      // psql-style backslash commands are client-side macros — translate.
      const meta = translateMeta(text);
      if (meta) {
        if (meta.kind === "sql") {
          updateTab(id, { title: meta.title, customTitle: true });
          return runSqlRef.current!(meta.sql, id, opts);
        }
        if (meta.kind === "describe") {
          describeRef.current?.(meta.name, id);
          return Promise.resolve(true);
        }
        if (meta.kind === "conninfo") {
          const c = connRef.current;
          const prof = activeProfileRef.current;
          updateTab(id, {
            notice: c
              ? `connected to ${c.database} as ${c.user}\nserver: PostgreSQL ${c.serverVersion} @ ${prof?.host ?? "?"}${prof?.sshEnabled ? " (via SSH tunnel)" : ""}\nprofile: ${prof?.name ?? "?"}${readOnlyRef.current ? "\nsession is read-only" : ""}`
              : "not connected",
            columns: [],
            rows: [],
            plan: null,
            structure: null,
            error: "",
            status: "",
          });
          return Promise.resolve(true);
        }
        updateTab(id, {
          notice: (meta.unknown ? `unrecognized command: ${meta.unknown}\n\n` : "") + META_HELP,
          columns: [],
          rows: [],
          plan: null,
          structure: null,
          error: "",
          status: "",
        });
        return Promise.resolve(true);
      }

      const warning = confirmDangerous(text);
      if (warning && !window.confirm(warning)) {
        updateTab(id, { status: "cancelled" });
        return Promise.resolve(false);
      }
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
                structure: null,
                structureTitle: "",
                notice: "",
                special: null,
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
              status: ev.truncated
                ? `first ${n.toLocaleString()} rows (capped — refine the query or export) in ${ev.elapsedMs ?? "?"} ms`
                : `${n.toLocaleString()} row${n === 1 ? "" : "s"} in ${ev.elapsedMs ?? "?"} ms`,
              running: false,
            });
            loadHistoryRef.current();
            resolve(true);
            break;
          }
          case "error": {
            const dead =
              /connection closed|no connection #|communicating with the server|broken pipe|connection reset|unexpected eof/i.test(
                ev.message,
              );
            const prof = activeProfileRef.current;
            if (dead && !opts?.retried && prof) {
              // Laptop-sleep resilience: reconnect the profile and retry once.
              updateTab(id, { status: "connection lost — reconnecting…" });
              connectProfile(prof)
                .then((info) => runSql(text, id, { retried: true, connId: info.connId }))
                .then((ok) => resolve(ok))
                .catch(() => {
                  updateTab(id, {
                    error: `${ev.message}\n\n(automatic reconnect failed)`,
                    running: false,
                  });
                  resolve(false);
                });
              break;
            }
            const wasInTx = tabsRef.current.find((t) => t.id === id)?.tx === "open";
            updateTab(id, {
              error: ev.message,
              running: false,
              ...(wasInTx ? { tx: "aborted" as const } : {}),
            });
            loadHistoryRef.current();
            resolve(false);
            break;
          }
        }
      };

      invoke("run_query", { connId, tabId: id, sql: text, onEvent: channel }).catch((e) => {
        updateTab(id, { error: String(e), running: false });
        resolve(false);
      });
      });
    },
    [connectProfile, updateTab],
  );
  const runSqlRef = useRef(runSql);
  runSqlRef.current = runSql;

  /** \d <name>: resolve schema (catalog lookup for bare names) and show structure. */
  const describeTable = useCallback(
    async (name: string, tabId: number) => {
      const connId = connRef.current?.connId;
      if (!connId) return;
      let schema = "public";
      let table = name;
      if (name.includes(".")) {
        [schema, table] = name.split(".");
      } else {
        const hit = objectsRef.current.find((o) => o.name === name);
        if (hit) schema = hit.schema;
      }
      try {
        const structure = await invoke<TableStructure>("table_structure", {
          connId,
          schema,
          table,
        });
        if (!structure.columns.length) {
          updateTab(tabId, { notice: `no table found: ${schema}.${table}`, error: "" });
          return;
        }
        updateTab(tabId, {
          structure,
          structureTitle: `${schema}.${table}`,
          title: table,
          customTitle: true,
          columns: [],
          rows: [],
          plan: null,
          notice: "",
          error: "",
          status: "",
        });
      } catch (e) {
        updateTab(tabId, { error: String(e) });
      }
    },
    [updateTab],
  );
  const describeRef = useRef(describeTable);
  describeRef.current = describeTable;

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
              t.id === id && t.error
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
          tabId: id,
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
    const connId = connRef.current?.connId;
    if (!connId) return;
    try {
      await invoke("cancel_query", { connId, tabId: activeTabIdRef.current });
    } catch {
      // Cancellation is best-effort; the running query surfaces the error.
    }
  }, []);

  const addTab = useCallback((sql = "") => {
    const id = nextTabId.current++;
    setTabs((ts) => [...ts, blankTab(id, sql)]);
    setActiveTabId(id);
    return id;
  }, []);

  const [readOnly, setReadOnly] = useState(false);
  const readOnlyRef = useRef(readOnly);
  readOnlyRef.current = readOnly;
  const [snippets, setSnippets] = useState<Snippet[]>([]);
  const [showPalette, setShowPalette] = useState(false);
  const [aiProviders, setAiProviders] = useState<
    { id: string; label: string; available: boolean; current: boolean }[]
  >([]);
  const [aiBypass, setAiBypass] = useState(false);
  const loadProviders = useCallback(async () => {
    try {
      setAiProviders(await invoke("ai_providers"));
      setAiBypass(await invoke("ai_get_bypass"));
    } catch {
      // AI provider list is non-critical
    }
  }, []);
  useEffect(() => {
    loadProviders();
  }, [loadProviders]);
  const [aiCtx, setAiCtx] = useState<{ phase: "exploring" | "ready"; text: string; error: string } | null>(null);
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

  const txAction = useCallback(
    async (action: "begin" | "commit" | "rollback") => {
      const connId = connRef.current?.connId;
      const tabId = activeTabIdRef.current;
      if (!connId) return;
      try {
        await invoke("exec_session", { connId, tabId, sql: action });
        updateTab(tabId, { tx: action === "begin" ? "open" : "none" });
      } catch {
        // Failed tx control: reflect reality as best we can.
        if (action !== "begin") updateTab(tabId, { tx: "none" });
      }
    },
    [updateTab],
  );

  const toggleReadOnly = useCallback(async () => {
    const connId = connRef.current?.connId;
    if (!connId) return;
    const next = !readOnly;
    try {
      await invoke("set_read_only", { connId, on: next });
      setReadOnly(next);
    } catch {
      // surfaced on next query if the session is dead
    }
  }, [readOnly]);

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
        const connId = connRef.current?.connId;
        if (connId) invoke("close_session", { connId, tabId: id }).catch(() => {});
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
      } else if ((e.metaKey || e.ctrlKey) && (e.key === "n" || e.key === "N")) {
        // ⌘⇧N → new window on the same connection; ⌘N → new blank window.
        e.preventDefault();
        const query =
          e.shiftKey && activeProfileRef.current?.id
            ? `profile=${activeProfileRef.current.id}`
            : "connect=none";
        invoke("open_new_window", { query }).catch(() => {});
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

  /** Load and show the Structure view for the tab's source table. */
  const showStructure = useCallback(
    async (tabId: number) => {
      const t = tabsRef.current.find((x) => x.id === tabId);
      const connId = connRef.current?.connId;
      if (!t?.editable || !connId) return;
      try {
        const structure = await invoke<TableStructure>("table_structure", {
          connId,
          schema: t.editable.schema,
          table: t.editable.table,
        });
        updateTab(tabId, {
          structure,
          structureTitle: `${t.editable.schema}.${t.editable.table}`,
        });
      } catch (e) {
        updateTab(tabId, { error: String(e) });
      }
    },
    [updateTab],
  );

  /** Export the FULL result of the tab's last query — streamed server→file,
      no 50k cap. */
  const exportTab = useCallback(async (tabId: number, format: "csv" | "json") => {
    const t = tabsRef.current.find((x) => x.id === tabId);
    const connId = connRef.current?.connId;
    if (!t || !t.lastSql || !connId) return;
    const base = (t.editable?.table ?? t.title.replace(/\W+/g, "_") ?? "results").toLowerCase();
    const path = await save({
      defaultPath: `${base}.${format}`,
      filters: [{ name: format.toUpperCase(), extensions: [format] }],
    });
    if (!path) return;
    updateTab(tabId, { status: "exporting…" });
    try {
      const n = await invoke<number>("export_query", {
        connId,
        tabId,
        sql: t.lastSql,
        format,
        path,
      });
      updateTab(tabId, {
        status: `exported ${n.toLocaleString()} rows → ${path.split("/").pop()}`,
      });
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

  /** Shared context assembly for Ask-AI. */
  const aiSchemaLines = useCallback(
    () =>
      catalog
        .map(
          (t) =>
            `${t.schema}.${t.name} (${t.columns.map((c) => `${c.name} ${c.dataType}`).join(", ")})`,
        )
        .join("\n"),
    [catalog],
  );

  /**
   * Ask-AI. "new": schema (+ CLAUDE.md via cwd) only, result in a fresh tab.
   * "current": additionally sends the current tab's SQL and sample rows, and
   * the result replaces the current tab's content (undoable in the editor).
   */
  const aiAsk = useCallback(
    async (prompt: string, mode: "new" | "current") => {
      if (!activeProfile?.id) return;
      const profileId = activeProfile.id;
      const active = tabsRef.current.find((t) => t.id === activeTabIdRef.current);
      const truncCell = (v: unknown) => {
        if (v === null) return null;
        const str = typeof v === "object" ? JSON.stringify(v) : String(v);
        return str.length > 200 ? str.slice(0, 200) + "…" : str;
      };

      const sections = ["=== SCHEMA (PostgreSQL) ===", aiSchemaLines() || "(no schema loaded)"];
      if (mode === "current" && active) {
        if (active.columns.length && active.rows.length) {
          const name = active.editable
            ? `${active.editable.schema}.${active.editable.table}`
            : active.title;
          const rows = active.rows
            .slice(0, 5)
            .map((r) =>
              Object.fromEntries(active.columns.map((c, i) => [c.name, truncCell(r[i])])),
            );
          sections.push(
            "",
            "=== CURRENT TAB SAMPLE ROWS ===",
            `-- ${name}\n${JSON.stringify(rows).slice(0, 8000)}`,
          );
        }
        sections.push("", "=== CURRENT TAB SQL (modify/extend this) ===", active.sql.slice(0, 4000));
      }
      const context = sections.join("\n");

      let targetId: number;
      if (mode === "new") {
        targetId = addTab(`-- ✦ ${prompt}\n-- generating…`);
        updateTab(targetId, {
          title: prompt.slice(0, 24) || "AI query",
          customTitle: true,
          running: true,
        });
      } else {
        targetId = active?.id ?? activeTabIdRef.current;
        updateTab(targetId, { running: true, error: "" });
      }

      try {
        const sql = await invoke<string>("ai_generate_query", { profileId, prompt, context });
        updateTab(targetId, { sql: `-- ✦ ${prompt}\n${sql}`, running: false });
      } catch (e) {
        updateTab(targetId, { error: String(e), running: false });
      }
    },
    [activeProfile, aiSchemaLines, addTab, updateTab],
  );

  /** Initialize AI context: agentic read-only exploration → CLAUDE.md. */
  const aiExplore = useCallback(
    async (guidance: string) => {
      if (!activeProfile?.id) return;
      setAiCtx({ phase: "exploring", text: "", error: "" });
      try {
        const doc = await invoke<string>("ai_explore_context", {
          profileId: activeProfile.id,
          guidance,
          schema: aiSchemaLines(),
        });
        setAiCtx({ phase: "ready", text: doc, error: "" });
      } catch (e) {
        const existing = await invoke<string | null>("ai_load_context", {
          profileId: activeProfile.id,
        }).catch(() => null);
        setAiCtx({ phase: "ready", text: existing ?? "", error: String(e) });
      }
    },
    [activeProfile, aiSchemaLines],
  );

  const aiOpenContext = useCallback(async () => {
    if (!activeProfile?.id) return;
    const existing = await invoke<string | null>("ai_load_context", {
      profileId: activeProfile.id,
    }).catch(() => null);
    setAiCtx({ phase: "ready", text: existing ?? "", error: "" });
  }, [activeProfile]);

  const aiSaveContext = useCallback(
    async (text: string) => {
      if (!activeProfile?.id) return;
      try {
        await invoke("ai_save_context", { profileId: activeProfile.id, text });
      } finally {
        setAiCtx(null);
      }
    },
    [activeProfile],
  );

  /** Open a special view in the active tab if it's blank, else a new tab. */
  const openSpecial = useCallback(
    (kind: "monitor" | "notify" | "er" | "diff", title: string) => {
      const active = tabsRef.current.find((t) => t.id === activeTabIdRef.current);
      const id =
        active && !active.sql.trim() && active.columns.length === 0 ? active.id : addTab();
      updateTab(id, {
        special: kind,
        title,
        customTitle: true,
        columns: [],
        rows: [],
        plan: null,
        structure: null,
        notice: "",
        error: "",
        status: "",
      });
    },
    [addTab, updateTab],
  );

  const paletteItems = useMemo<PaletteItem[]>(() => {
    const items: PaletteItem[] = [
      {
        id: "ai-new",
        label: "Ask AI → new tab…",
        group: "ai",
        hint: "schema + notes",
        prompt: {
          placeholder: "Describe the query you want…",
          submit: (p) => aiAsk(p, "new"),
        },
      },
      {
        id: "ai-current",
        label: "Ask AI → current tab…",
        group: "ai",
        hint: "+ this tab's SQL & rows",
        prompt: {
          placeholder: "Modify/extend the current tab: describe what you want…",
          submit: (p) => aiAsk(p, "current"),
        },
      },
      {
        id: "ai-init",
        label: "Initialize AI context (explore database)…",
        group: "ai",
        hint: "read-only, writes CLAUDE.md",
        prompt: {
          placeholder: "Optional guidance (e.g. focus on battle tables) — ↵ to start",
          allowEmpty: true,
          submit: (g) => aiExplore(g),
        },
      },
      {
        id: "ai-view",
        label: "View / edit AI context",
        group: "ai",
        run: () => aiOpenContext(),
      },
      ...aiProviders.map((p) => ({
        id: `ai-provider-${p.id}`,
        label: `AI provider: ${p.label}${p.current ? " ✓" : ""}`,
        group: "ai",
        hint: p.available ? (p.current ? "current" : "installed") : "not installed",
        run: async () => {
          try {
            await invoke("ai_set_provider", { provider: p.id });
            await loadProviders();
          } catch {
            // ignore
          }
        },
      })),
      {
        id: "ai-bypass",
        label: `${aiBypass ? "Disable" : "Enable"} AI shell access (Codex / opencode)`,
        group: "ai",
        hint: aiBypass ? "on — runs psql unsandboxed" : "off — needed for their DB exploration",
        run: async () => {
          try {
            await invoke("ai_set_bypass", { enabled: !aiBypass });
            await loadProviders();
          } catch {
            // ignore
          }
        },
      },
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
    const activeTx = tabsRef.current.find((t) => t.id === activeTabIdRef.current)?.tx ?? "none";
    if (activeTx === "none") {
      items.push({ id: "begin", label: "Begin transaction (this tab)", group: "cmd", run: () => txAction("begin") });
    } else {
      items.push(
        { id: "commit", label: "Commit transaction", group: "cmd", run: () => txAction("commit") },
        { id: "rollback", label: "Rollback transaction", group: "cmd", run: () => txAction("rollback") },
      );
    }
    items.push(
      { id: "monitor", label: "Activity monitor", group: "server", hint: "pg_stat_activity + kill", run: () => openSpecial("monitor", "activity") },
      { id: "diff", label: "Schema diff…", group: "server", hint: "compare two profiles", run: () => openSpecial("diff", "schema diff") },
      { id: "notify", label: "LISTEN / NOTIFY console", group: "server", run: () => openSpecial("notify", "notify") },
      { id: "er", label: "ER diagram", group: "server", hint: "FK graph, draggable", run: () => openSpecial("er", "ER diagram") },
    );
    items.push({
      id: "new-window",
      label: "New window",
      group: "cmd",
      hint: "⌘N — no connection",
      run: () => invoke("open_new_window", { query: "connect=none" }).catch(() => {}),
    });
    if (activeProfile?.id) {
      items.push({
        id: "new-window-same",
        label: "New window (same connection)",
        group: "cmd",
        hint: "⌘⇧N",
        run: () =>
          invoke("open_new_window", { query: `profile=${activeProfile.id}` }).catch(() => {}),
      });
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
    tabs,
    txAction,
    objects,
    snippets,
    openObject,
    updateTab,
    loadSnippets,
    exportTab,
    aiAsk,
    openSpecial,
    aiExplore,
    aiOpenContext,
    aiProviders,
    aiBypass,
    loadProviders,
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

      {aiCtx && (
        <AiContextModal
          phase={aiCtx.phase}
          text={aiCtx.text}
          error={aiCtx.error}
          profileName={activeProfile?.name ?? ""}
          onSave={aiSaveContext}
          onClose={() => setAiCtx(null)}
        />
      )}

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
                <div className="schema-row server-head">Server</div>
                {SERVER_QUERIES.map((q) => (
                  <div
                    key={q.key}
                    className="item-row"
                    onClick={() => {
                      if (q.key === "activity") {
                        openSpecial("monitor", "activity");
                        return;
                      }
                      const id = activeTabIdRef.current;
                      updateTab(id, { title: q.title, customTitle: true });
                      runSql(q.sql, id);
                    }}
                    title={q.title}
                  >
                    <span className="obj-icon server">⚙</span>
                    {q.label}
                  </div>
                ))}
                <div
                  className="item-row"
                  onClick={() => openSpecial("er", "ER diagram")}
                  title="foreign-key graph"
                >
                  <span className="obj-icon server">⚙</span>
                  ER diagram
                </div>
                <div className="schema-row server-head">Schemas</div>
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
              ) : t.notice ? (
                <pre className="notice-pane">{t.notice}</pre>
              ) : t.special === "monitor" && conn ? (
                <MonitorView connId={conn.connId} />
              ) : t.special === "notify" && conn ? (
                <NotifyView connId={conn.connId} />
              ) : t.special === "er" && conn && activeProfile?.id ? (
                <ERView connId={conn.connId} profileId={activeProfile.id} tables={catalog} />
              ) : t.special === "diff" ? (
                <DiffView profiles={profiles} defaultA={activeProfile?.id ?? null} />
              ) : t.structure ? (
                <StructureView
                  table={t.structureTitle}
                  structure={t.structure}
                  onBackToData={() => updateTab(t.id, { structure: null })}
                />
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
                        tabId: t.id,
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
                    onStructure={() => showStructure(t.id)}
                  />
                )
              )}
            </div>
          ))}

          <div className="statusbar">
            <span className="hint">
              {activeTab.tx === "none" && (
                <button className="btn mini" disabled={!conn} onClick={() => txAction("begin")}>
                  Begin
                </button>
              )}
              {activeTab.tx !== "none" && (
                <>
                  <span className={`tx-state ${activeTab.tx}`}>
                    {activeTab.tx === "open" ? "in transaction (this tab)" : "transaction aborted"}
                  </span>
                  {activeTab.tx === "open" && (
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
