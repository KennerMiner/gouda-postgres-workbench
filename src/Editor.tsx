import { useEffect, useRef } from "react";
import { EditorView, keymap, lineNumbers, highlightActiveLine, drawSelection } from "@codemirror/view";
import { Compartment, EditorState, Prec } from "@codemirror/state";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import {
  acceptCompletion,
  autocompletion,
  completionKeymap,
  startCompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
  type CompletionSource,
} from "@codemirror/autocomplete";
import {
  sql,
  PostgreSQL,
  keywordCompletionSource,
  schemaCompletionSource,
  type SQLNamespace,
} from "@codemirror/lang-sql";
import type { CatalogTable } from "./sqlNamespace";
import { insertColumnCandidates, insertColumnList } from "./insertCompletion";
import {
  HighlightStyle,
  syntaxHighlighting,
  bracketMatching,
  syntaxTree,
} from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import { statementAt } from "./sqlStatements";

/// Keywords whose trailing space should pop the full completion list —
/// the schema *is* the likely answer right after these.
const TRIGGER_WORDS = new Set([
  "from",
  "join",
  "update",
  "into",
  "table",
  "select",
  "where",
  "and",
  "or",
  "on",
  "set",
  "by",
  "having",
  "returning",
  "using",
]);

/**
 * Completions for `insert into t (…|` — the columns of `t`, minus any already
 * listed, re-offered after each comma. Returns null outside that context so
 * the schema/keyword sources take over.
 */
function insertColumnsSource(catalog: CatalogTable[]): CompletionSource {
  return (context: CompletionContext): CompletionResult | null => {
    const text = context.state.doc.sliceString(0, context.pos);
    const cols = insertColumnCandidates(catalog, text);
    if (!cols) return null;
    const options: Completion[] = cols.map((c) => ({
      label: c.name,
      type: "property",
      detail: c.dataType,
    }));
    const word = /[\w$]*$/.exec(text)![0];
    return { from: context.pos - word.length, options, validFor: /^[\w$]*$/ };
  };
}

/** Wrap a source so it stays quiet inside an INSERT column list. */
function outsideInsertCols(src: CompletionSource): CompletionSource {
  return (context) =>
    insertColumnList(context.state.doc.sliceString(0, context.pos)) ? null : src(context);
}

/**
 * Context-triggered explicit completion: typing a space after a
 * completion-hungry keyword (or after a comma) issues the same request as
 * Ctrl-Space. Also fires on `(`/`,` inside an INSERT column list so the
 * column picker pops without needing a leading keystroke. Quiet inside
 * strings/comments; Esc dismisses until the next trigger event.
 */
const aggressiveCompletion = EditorView.updateListener.of((u) => {
  if (!u.docChanged) return;
  let typed = "";
  u.changes.iterChanges((_fa, _ta, _fb, _tb, ins) => {
    const s = ins.toString();
    if (s === " " || s === "(" || s === ",") typed = s;
  });
  if (!typed) return;
  const state = u.state;
  const pos = state.selection.main.head;
  const node = syntaxTree(state).resolveInner(pos, -1);
  if (/string|comment/i.test(node.name)) return;
  const fire = () => setTimeout(() => startCompletion(u.view), 0);

  // `(` / `,` inside an INSERT column list → offer that table's columns.
  if (typed === "(" || typed === ",") {
    if (insertColumnList(state.doc.sliceString(0, pos))) fire();
    if (typed === "(") return;
  }
  if (typed !== " ") return;

  const before = state.doc.sliceString(Math.max(0, pos - 60), pos);
  if (!before.endsWith(" ")) return;
  const trimmed = before.slice(0, -1).trimEnd();
  const word = /([A-Za-z_]+)$/.exec(trimmed)?.[1]?.toLowerCase();
  if (trimmed.endsWith(",") || (word !== undefined && TRIGGER_WORDS.has(word))) {
    // Defer: dispatching inside an update listener is not allowed. Fire
    // unconditionally — the plugin is often "pending" here on a query that
    // resolves to nothing (a bare space matches no source), and an explicit
    // startCompletion cleanly replaces it.
    fire();
  }
});

function sqlExtension(schema: SQLNamespace | null) {
  return sql({
    dialect: PostgreSQL,
    ...(schema ? { schema, defaultSchema: "public" } : {}),
  });
}

/**
 * Completion config. `override` replaces lang-sql's language-data sources so
 * we control ordering: the INSERT column picker runs first, and the schema +
 * keyword sources are gated off inside an INSERT column list.
 */
function completionExt(schema: SQLNamespace | null, catalog: CatalogTable[]) {
  const cfg = { dialect: PostgreSQL, defaultSchema: "public", ...(schema ? { schema } : {}) };
  return autocompletion({
    activateOnTyping: true,
    maxRenderedOptions: 60,
    override: [
      insertColumnsSource(catalog),
      outsideInsertCols(schemaCompletionSource(cfg)),
      outsideInsertCols(keywordCompletionSource(PostgreSQL)),
    ],
  });
}

// Palette mirrors App.css.
const theme = EditorView.theme(
  {
    "&": { background: "#1c1e1f", color: "#d6d6d6", fontSize: "12px", height: "100%" },
    ".cm-content": { fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace', padding: "8px 0" },
    ".cm-gutters": {
      background: "#1c1e1f",
      color: "#5a5e62",
      border: "none",
      fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace',
      fontSize: "10.5px",
    },
    ".cm-activeLine": { background: "#26282a66" },
    ".cm-activeLineGutter": { background: "transparent", color: "#909396" },
    "&.cm-focused": { outline: "none" },
    ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
      background: "#2e4a35 !important",
    },
    ".cm-cursor": { borderLeftColor: "#4caf50" },
    ".cm-tooltip": {
      background: "#26282a",
      border: "1px solid #353738",
      borderRadius: "6px",
    },
    ".cm-tooltip.cm-tooltip-autocomplete > ul": {
      fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace',
      fontSize: "11.5px",
      maxHeight: "220px",
    },
    ".cm-tooltip.cm-tooltip-autocomplete > ul > li": {
      padding: "2px 8px",
    },
    ".cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]": {
      background: "#2e4a35",
      color: "#d6d6d6",
    },
    ".cm-completionLabel": { color: "#d6d6d6" },
    ".cm-completionMatchedText": {
      textDecoration: "none",
      color: "#4caf50",
      fontWeight: "600",
    },
    ".cm-completionDetail": {
      color: "#8a8f98",
      fontStyle: "normal",
      fontSize: "10px",
      marginLeft: "1em",
    },
    ".cm-completionIcon": { width: "1em", opacity: "0.6" },
  },
  { dark: true },
);

const highlight = HighlightStyle.define([
  { tag: t.keyword, color: "#6fb3e0", fontWeight: "600" },
  { tag: t.string, color: "#9ece6a" },
  { tag: t.number, color: "#d9a05f" },
  { tag: t.comment, color: "#5a5e62", fontStyle: "italic" },
  { tag: t.operator, color: "#a8adb3" },
  { tag: t.typeName, color: "#b58fd4" },
  { tag: t.propertyName, color: "#d6d6d6" },
  { tag: t.punctuation, color: "#8a8f96" },
]);

type Props = {
  /** Identity of the current tab; each tab keeps its own EditorState. */
  tabId: number;
  value: string;
  onChange: (text: string) => void;
  /** Called with the SQL to execute: selection if any, else statement under cursor. */
  onRun: (sql: string) => void;
  /** ⌘⇧↵ — run the whole script. */
  onRunAll: (sql: string) => void;
  /** ⌘E — explain the statement under the cursor. */
  onExplain: (sql: string) => void;
  /** Live schema for completions; null until the catalog loads. */
  schema: SQLNamespace | null;
  /** Raw catalog (with columns) powering INSERT column completion. */
  catalog: CatalogTable[];
};

export default function Editor({
  tabId,
  value,
  onChange,
  onRun,
  onRunAll,
  onExplain,
  schema,
  catalog,
}: Props) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const sqlCompartment = useRef(new Compartment());
  const completionCompartment = useRef(new Compartment());
  // Per-tab editor states (undo history, cursor, scroll) + the extension
  // array from mount, reused when a fresh tab needs a state.
  const tabStates = useRef(new Map<number, EditorState>());
  const prevTabId = useRef(tabId);
  const extensionsRef = useRef<import("@codemirror/state").Extension | null>(null);
  // Refs so the CodeMirror keymap (created once) always sees current handlers.
  const onRunRef = useRef(onRun);
  const onRunAllRef = useRef(onRunAll);
  const onExplainRef = useRef(onExplain);
  const onChangeRef = useRef(onChange);
  const schemaRef = useRef(schema);
  const catalogRef = useRef(catalog);
  onRunRef.current = onRun;
  onRunAllRef.current = onRunAll;
  onExplainRef.current = onExplain;
  onChangeRef.current = onChange;
  schemaRef.current = schema;
  catalogRef.current = catalog;

  useEffect(() => {
    if (!host.current) return;

    const runKeymap = Prec.highest(
      keymap.of([
        // Tab accepts the open completion; falls through to indentWithTab
        // when no completion is active.
        { key: "Tab", run: acceptCompletion },
        {
          key: "Mod-Shift-Enter",
          run: (v) => {
            const text = v.state.doc.toString();
            if (text.trim()) onRunAllRef.current(text);
            return true;
          },
        },
        {
          key: "Mod-Enter",
          run: (v) => {
            const sel = v.state.selection.main;
            const text = v.state.doc.toString();
            const toRun = sel.empty
              ? statementAt(text, sel.head)
              : text.slice(sel.from, sel.to).trim();
            if (toRun) onRunRef.current(toRun);
            return true;
          },
        },
        {
          key: "Mod-e",
          run: (v) => {
            const sel = v.state.selection.main;
            const text = v.state.doc.toString();
            const stmt = sel.empty
              ? statementAt(text, sel.head)
              : text.slice(sel.from, sel.to).trim();
            if (stmt) onExplainRef.current(stmt);
            return true;
          },
        },
      ]),
    );

    const extensions = [
      runKeymap,
      lineNumbers(),
      history(),
      drawSelection(),
      highlightActiveLine(),
      bracketMatching(),
      completionCompartment.current.of(completionExt(null, [])),
      aggressiveCompletion,
      keymap.of([...defaultKeymap, ...historyKeymap, ...completionKeymap, indentWithTab]),
      sqlCompartment.current.of(sqlExtension(null)),
      syntaxHighlighting(highlight),
      EditorView.lineWrapping,
      theme,
      EditorView.updateListener.of((u) => {
        if (u.docChanged) onChangeRef.current(u.state.doc.toString());
      }),
    ];
    extensionsRef.current = extensions;

    const v = new EditorView({
      parent: host.current,
      state: EditorState.create({ doc: value, extensions }),
    });
    view.current = v;
    return () => v.destroy();
    // Mount once; external value changes are pushed in the effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Tab switch: save the outgoing tab's full editor state (undo history,
  // cursor, scroll) and restore/create the incoming one. Runs before the
  // value-sync effect below, which then sees the doc already correct.
  useEffect(() => {
    const v = view.current;
    if (!v || prevTabId.current === tabId) return;
    tabStates.current.set(prevTabId.current, v.state);
    prevTabId.current = tabId;
    const saved = tabStates.current.get(tabId);
    v.setState(
      saved ?? EditorState.create({ doc: value, extensions: extensionsRef.current! }),
    );
    // A stored state may carry a stale schema config — re-apply the live one.
    v.dispatch({
      effects: [
        sqlCompartment.current.reconfigure(sqlExtension(schemaRef.current)),
        completionCompartment.current.reconfigure(
          completionExt(schemaRef.current, catalogRef.current),
        ),
      ],
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabId]);

  // Push programmatic changes (e.g. sidebar click) into the editor.
  useEffect(() => {
    const v = view.current;
    if (!v) return;
    const current = v.state.doc.toString();
    if (current !== value) {
      v.dispatch({ changes: { from: 0, to: current.length, insert: value } });
    }
  }, [value]);

  // Swap in the live schema/catalog when they (re)load.
  useEffect(() => {
    view.current?.dispatch({
      effects: [
        sqlCompartment.current.reconfigure(sqlExtension(schema)),
        completionCompartment.current.reconfigure(completionExt(schema, catalog)),
      ],
    });
  }, [schema, catalog]);

  return <div className="editor-host" ref={host} />;
}
