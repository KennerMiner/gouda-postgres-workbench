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
- [ ] Connection manager: profiles in SQLite, secrets in Keychain, SSL modes
- [ ] SSH tunnel support (russh)
- [ ] Connection pooling + one persistent session per tab (deadpool)
- [ ] CodeMirror 6 editor: tabs, run-all / run-selection / run-statement-under-cursor
- [ ] Query cancellation (tokio-postgres cancel_token) + timeout
- [ ] Multi-statement scripts (simple_query path for non-preparable statements)
- [ ] Schema tree: databases → schemas → tables/views/functions/types
- [ ] Virtualized grid (TanStack Virtual): 100k rows without jank, cell selection,
      JSONB/array cell expansion popover
- [ ] Persistent searchable query history (SQLite)
- [ ] Export: CSV / JSON / SQL inserts (COPY TO for big sets)

### M2 — Better than Beekeeper
- [ ] Schema-aware autocomplete (live catalog → CodeMirror completions)
- [ ] Inline data editing → generated UPDATE/INSERT, diff preview before commit
      (PK detection per table; no PK → read-only)
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
