import { useState } from "react";
import { copyText } from "./clipboard";

/**
 * Collapsible typed JSON tree with filtering and copy-as-Postgres-path.
 *
 * Each node manages its own expanded state, seeded from `defaultDepth`; the
 * parent remounts the tree (key change) to implement expand/collapse-all.
 * When a filter is active, rendering is pruned to `keep` paths and every
 * surviving container is force-expanded.
 */

type Path = (string | number)[];

const SEP = "";
const pathKey = (p: Path) => p.join(SEP);

/** Postgres operator syntax for a path under `column`; ->> for scalar leaves. */
export function pgPath(column: string, path: Path, leafScalar: boolean): string {
  const col = `"${column.replace(/"/g, '""')}"`;
  if (path.length === 0) return col;
  return (
    col +
    path
      .map((p, i) => {
        const op = i === path.length - 1 && leafScalar ? "->>" : "->";
        return typeof p === "number" ? `${op}${p}` : `${op}'${String(p).replace(/'/g, "''")}'`;
      })
      .join("")
  );
}

/** Paths to render while filtering: matches, their ancestors, their subtrees. */
export function computeKeep(root: unknown, filter: string): { keep: Set<string>; matches: number } {
  const keep = new Set<string>();
  const f = filter.toLowerCase();
  let matches = 0;

  const keepSubtree = (v: unknown, path: Path) => {
    keep.add(pathKey(path));
    if (v !== null && typeof v === "object") {
      const entries = Array.isArray(v)
        ? v.map((x, i) => [i, x] as [number, unknown])
        : Object.entries(v);
      for (const [k, cv] of entries) keepSubtree(cv, [...path, k]);
    }
  };

  const walk = (v: unknown, path: Path): boolean => {
    const keyName = path.length ? String(path[path.length - 1]) : "";
    const keyMatch = keyName !== "" && keyName.toLowerCase().includes(f);
    let hit = false;
    if (v !== null && typeof v === "object") {
      const entries = Array.isArray(v)
        ? v.map((x, i) => [i, x] as [number, unknown])
        : Object.entries(v);
      let childHit = false;
      for (const [k, cv] of entries) {
        if (walk(cv, [...path, k])) childHit = true;
      }
      if (keyMatch) {
        matches++;
        keepSubtree(v, path);
      }
      hit = childHit || keyMatch;
    } else {
      const valMatch = String(v).toLowerCase().includes(f);
      if (keyMatch || valMatch) {
        matches++;
        hit = true;
      }
    }
    if (hit) keep.add(pathKey(path));
    return hit;
  };

  walk(root, []);
  return { keep, matches };
}

function Highlight({ text, filter }: { text: string; filter: string }) {
  if (!filter) return <>{text}</>;
  const i = text.toLowerCase().indexOf(filter.toLowerCase());
  if (i === -1) return <>{text}</>;
  return (
    <>
      {text.slice(0, i)}
      <mark>{text.slice(i, i + filter.length)}</mark>
      {text.slice(i + filter.length)}
    </>
  );
}

function Leaf({ value, filter }: { value: unknown; filter: string }) {
  if (value === null) return <span className="jt-null">null</span>;
  switch (typeof value) {
    case "string":
      return (
        <span className="jt-str">
          "<Highlight text={value} filter={filter} />"
        </span>
      );
    case "number":
      return (
        <span className="jt-num">
          <Highlight text={String(value)} filter={filter} />
        </span>
      );
    case "boolean":
      return <span className="jt-bool">{String(value)}</span>;
    default:
      return <span>{String(value)}</span>;
  }
}

function summarize(value: unknown): string {
  if (Array.isArray(value)) return `[…] ${value.length} item${value.length === 1 ? "" : "s"}`;
  const n = Object.keys(value as object).length;
  return `{…} ${n} key${n === 1 ? "" : "s"}`;
}

function CopyPath({ column, path, scalar }: { column: string; path: Path; scalar: boolean }) {
  const [done, setDone] = useState(false);
  if (path.length === 0) return null;
  return (
    <button
      className="jt-copy"
      title={pgPath(column, path, scalar)}
      onClick={(e) => {
        e.stopPropagation();
        copyText(pgPath(column, path, scalar));
        setDone(true);
        setTimeout(() => setDone(false), 1000);
      }}
    >
      {done ? "✓" : "⧉"}
    </button>
  );
}

type NodeProps = {
  name: string | null;
  value: unknown;
  path: Path;
  depth: number;
  defaultDepth: number;
  column: string;
  filter: string;
  keep: Set<string> | null;
};

function JsonNode({ name, value, path, depth, defaultDepth, column, filter, keep }: NodeProps) {
  const [open, setOpen] = useState(depth < defaultDepth);
  if (keep !== null && !keep.has(pathKey(path))) return null;
  const expanded = keep !== null ? true : open;
  const isObj = value !== null && typeof value === "object";

  if (!isObj) {
    return (
      <div className="jt-row" style={{ paddingLeft: depth * 14 }}>
        <span className="jt-chevron" />
        {name !== null && (
          <span className="jt-key">
            <Highlight text={name} filter={filter} />:{" "}
          </span>
        )}
        <Leaf value={value} filter={filter} />
        <CopyPath column={column} path={path} scalar />
      </div>
    );
  }

  const entries: [string | number, unknown][] = Array.isArray(value)
    ? value.map((v, i) => [i, v] as [number, unknown])
    : Object.entries(value as Record<string, unknown>);

  return (
    <div>
      <div
        className="jt-row jt-toggle"
        style={{ paddingLeft: depth * 14 }}
        onClick={() => setOpen(!open)}
      >
        <span className="jt-chevron">{expanded ? "⌄" : "›"}</span>
        {name !== null && (
          <span className="jt-key">
            <Highlight text={name} filter={filter} />:{" "}
          </span>
        )}
        {expanded ? (
          <span className="jt-brace">{Array.isArray(value) ? "[" : "{"}</span>
        ) : (
          <span className="jt-summary">{summarize(value)}</span>
        )}
        <CopyPath column={column} path={path} scalar={false} />
      </div>
      {expanded && (
        <>
          {entries.map(([k, v]) => (
            <JsonNode
              key={String(k)}
              name={String(k)}
              value={v}
              path={[...path, k]}
              depth={depth + 1}
              defaultDepth={defaultDepth}
              column={column}
              filter={filter}
              keep={keep}
            />
          ))}
          <div className="jt-row" style={{ paddingLeft: depth * 14 }}>
            <span className="jt-chevron" />
            <span className="jt-brace">{Array.isArray(value) ? "]" : "}"}</span>
          </div>
        </>
      )}
    </div>
  );
}

type Props = {
  value: unknown;
  defaultDepth: number;
  column: string;
  filter?: string;
  keep?: Set<string> | null;
};

export default function JsonTree({ value, defaultDepth, column, filter = "", keep = null }: Props) {
  return (
    <div className="json-tree">
      <JsonNode
        name={null}
        value={value}
        path={[]}
        depth={0}
        defaultDepth={defaultDepth}
        column={column}
        filter={filter}
        keep={keep}
      />
    </div>
  );
}
