# psqlViewer

A sleek Postgres client (TablePlus/Beekeeper energy) built on Tauri v2 + Rust + React.
Personal daily driver, macOS-first.

## Stack

- **Backend**: Rust — `tokio-postgres` (dynamic queries, portals, COPY),
  `deadpool-postgres` (pooling, M1), `russh` (SSH tunnels, M1), `keyring`
  (macOS Keychain, M1), `rusqlite` (history/profiles, M1)
- **Frontend**: Vite + React + TS — CodeMirror 6 (editor, M1), TanStack Virtual
  (grid, M1), cmdk (palette, M2), Zustand (state, M1)
- **IPC**: Tauri Channels stream rows Rust → UI in 500-row batches

## Milestones

### M0 — Vertical spike ✅
- [x] Tauri scaffold, Rust connects with DSN string
- [x] Single query via extended protocol, streamed over Channel
- [x] Core type mapping → JSON (bool, ints, floats, numeric, text, uuid,
      json/jsonb, timestamp/tz, date, time, bytea, text/int arrays) with
      text fallback for unmapped types
- [x] Dumb streaming results table, NULL rendering, timing in status bar
- [x] Type-mapper integration test against live Postgres

### M1 — MVP daily driver
- [x] Persistent connection registry (connect once, reuse across queries,
      evict dead connections, auto-connect on launch)
- [x] Sidebar: per-schema tree of tables/views/matviews/foreign tables with
      filter + click-to-browse (select * limit 500)
- [x] Live connection banner (server version, user, host, db)
- [x] Connection manager: profiles in SQLite, passwords in macOS Keychain,
      manager modal, per-profile banner colors, auto-connect most recent,
      'heroage local' seeded on first run (SSL modes still TODO)
- [x] SSH tunnel support (russh): agent + key-file auth, known_hosts
      verification, tunnel lifetime tied to connection; per-profile SSH
      section in the manager; end-to-end test against the dev bastion
- [ ] Connection pooling + one persistent session per tab (deadpool)
- [x] CodeMirror 6 editor: Postgres highlighting, ⌘↵ = run selection or
      statement under cursor (string/dollar-quote/comment-aware splitter,
      unit-tested)
- [x] Query cancellation (out-of-band cancel_token, Stop button)
- [x] Virtualized grid (TanStack Virtual): fixed 24px rows, content-measured
      column widths, sticky header + row gutter
- [x] Editor tabs: per-tab results/status/errors, per-tab editor state
      (undo/cursor), auto-title from query target, running indicator,
      ⌘T new / × close (run-all via simple_query still TODO)
- [x] Grid: cell selection (click/arrows/⌘C/Esc), JSONB/array inspector panel
      with collapsible typed tree + copy pretty/compact; >200KB falls back to
      text view
- [ ] Schema tree: add functions/types; column list under each table
- [x] Persistent searchable query history (SQLite in app-data dir, last 5000,
      Items/History sidebar tabs, click loads into editor)
- [ ] Export: CSV / JSON / SQL inserts (COPY TO for big sets)

### M2 — Better than Beekeeper
- [x] Schema-aware autocomplete: schema_catalog command (tables/views +
      columns + formatted types) → lang-sql namespace, reconfigured live on
      connect; column types as completion detail; themed popup
- [x] Inline data editing → generated UPDATEs with preview-before-commit:
      protocol-level PK detection (single table + full PK in result, else
      read-only), staged edits w/ amber tint, inline input or inspector
      textarea (JSON validated), backend dry-run preview, transactional
      apply where each UPDATE must hit exactly 1 row or all roll back
- [x] Row insert/delete: + Row pending rows (empty cell = DEFAULT, ⌘⌫ = NULL),
      ⌘⌫ toggles row deletion; one transactional ChangeSet ordered
      updates → deletes → inserts
- [ ] Visual EXPLAIN (ANALYZE, BUFFERS) plan tree
- [ ] Command palette (cmdk), saved snippets
- [ ] Transaction mode (manual commit) + read-only connection toggle
- [ ] Light theme

### M3 — Postgres-native flex
- [ ] pg_stat_activity monitor + kill backend
- [ ] Table/index size + bloat stats
- [ ] JSONB tree editor
- [ ] Extension browser
- [ ] LISTEN/NOTIFY console
- [ ] Schema diff between two connections
- [ ] ER diagram from FK graph

## Dev

```sh
npm run tauri dev        # run the app
cd src-tauri && cargo test   # type-mapper test (needs local PG up)
```

Local test DB: the `backend-postgres-1` Docker container
(`postgres://heroage:heroage@localhost:5432/heroage`).
