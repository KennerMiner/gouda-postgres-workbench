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
      'heroage local' seeded on first run
- [x] SSL modes: disable / require (encrypted, no verify) / verify-full
      (system trust store) — sessions, cancel tokens, test included
- [x] SSH tunnel support (russh): agent + key-file auth, known_hosts
      verification, tunnel lifetime tied to connection; per-profile SSH
      section in the manager; end-to-end test against the dev bastion
- [x] One session per tab (lazy, shared tunnel) — supersedes the pooling idea
- [x] CodeMirror 6 editor: Postgres highlighting, ⌘↵ = run selection or
      statement under cursor (string/dollar-quote/comment-aware splitter,
      unit-tested)
- [x] Query cancellation (out-of-band cancel_token, Stop button)
- [x] Virtualized grid (TanStack Virtual): fixed 24px rows, content-measured
      column widths, sticky header + row gutter
- [x] Editor tabs: per-tab results/status/errors, per-tab editor state
      (undo/cursor), auto-title from query target, running indicator,
      ⌘T new / × close, drag reorder, double-click rename
- [x] Run-all scripts: ⌘⇧↵ / Run button execute statements sequentially,
      stop at first failure with statement N-of-M context
- [x] Grid: cell selection (click/arrows/⌘C/Esc), JSONB/array inspector panel
      with collapsible typed tree + copy pretty/compact; >200KB falls back to
      text view
- [x] Schema tree: column list (name + type) under each table via chevron
      (functions/types still TODO)
- [x] Persistent searchable query history (SQLite in app-data dir, last 5000,
      Items/History sidebar tabs, click loads into editor)
- [x] Export: CSV / JSON via native save dialog — streamed server→file
      with no row cap (integration-tested at 100k rows); INSERT via
      row-selection copy

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
- [x] Visual EXPLAIN: plan tree w/ time/cost bars, self-time heat, est-vs-
      actual + filter-waste badges; ANALYZE gated to selects (writes are
      planned, never executed); ⌘E / Explain button
- [x] Command palette (⌘K, hand-rolled fuzzy): commands, open-table
      entries, snippets (save current SQL / insert / delete, SQLite-backed)
- [x] Transactions: Begin/Commit/Rollback in statusbar w/ open/aborted
      tracking; read-only rails: per-profile default + runtime lock toggle
      (default_transaction_read_only, server-enforced), grid editing gated
- [ ] Light theme

### Extras (landed along the way)
- [x] Must-have hardening: 50k row cap w/ server-side cancel + truncated
      status; auto-reconnect-and-retry on dead connections (laptop sleep);
      confirm on UPDATE/DELETE-without-WHERE and TRUNCATE/DROP; column
      header sort (source-index-safe with staged edits) + drag resize
- [x] Structure view (columns/defaults/nullability, indexes w/ PK+unique
      badges, constraints w/ definitions) via grid-toolbar toggle
- [x] Row selection (gutter click/shift/⌘) → copy CSV (⌘C) / TSV / INSERT
- [x] Session-per-tab: tabs query concurrently over one connection (+SSH
      tunnel shared); transactions are per-tab; Stop cancels the active
      tab; dead sessions respawn transparently
- [x] Multi-window (⌘⇧N): separate connection per window — the window
      boundary prevents wrong-server accidents; per-window tab sessions
- [x] Session persistence: tabs restore across launches (app_state KV)
- [x] Saved queries: snippets + sidebar Queries tab + palette flows
- [x] Ask AI (⌘K): claude CLI generates a commented query into a new tab —
      schema + already-fetched sample rows as context, never auto-runs
      (Anthropic API provider is the planned upgrade path)

### M3 — Postgres-native flex
- [x] pg_stat_activity monitor: live 2s refresh, state badges, running
      durations, cancel/kill per session
- [x] Table/index sizes (via \dt+ / \di and structure view; bloat TODO)
- [x] JSONB tree editor (inspector + jsonb_set staging)
- [x] Extension browser (\dx + sidebar Server section)
- [x] LISTEN/NOTIFY console: dedicated listener session forwards events
      live; subscribe chips, test sender
- [x] Schema diff between two profiles: columns/indexes/constraints,
      +/-/~ lines, ephemeral tunneled connections (diff logic unit-tested)
- [x] ER diagram from FK graph: draggable nodes, FK-highlighted columns,
      positions persisted per profile

## Dev

```sh
npm run tauri dev        # run the app
cd src-tauri && cargo test   # type-mapper test (needs local PG up)
```

Local test DB: the `backend-postgres-1` Docker container
(`postgres://heroage:heroage@localhost:5432/heroage`).
