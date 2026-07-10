import { useState } from "react";

/**
 * Collapsible typed JSON tree. Each node manages its own expanded state,
 * seeded from `defaultDepth`; the parent remounts the tree (key change) to
 * implement expand-all / collapse-all.
 */

type NodeProps = {
  name: string | null;
  value: unknown;
  depth: number;
  defaultDepth: number;
};

function summarize(value: unknown): string {
  if (Array.isArray(value)) return `[…] ${value.length} item${value.length === 1 ? "" : "s"}`;
  if (value !== null && typeof value === "object")
    return `{…} ${Object.keys(value).length} key${Object.keys(value).length === 1 ? "" : "s"}`;
  return "";
}

function Leaf({ value }: { value: unknown }) {
  if (value === null) return <span className="jt-null">null</span>;
  switch (typeof value) {
    case "string":
      return <span className="jt-str">"{value}"</span>;
    case "number":
      return <span className="jt-num">{String(value)}</span>;
    case "boolean":
      return <span className="jt-bool">{String(value)}</span>;
    default:
      return <span>{String(value)}</span>;
  }
}

function JsonNode({ name, value, depth, defaultDepth }: NodeProps) {
  const [open, setOpen] = useState(depth < defaultDepth);
  const isObj = value !== null && typeof value === "object";

  if (!isObj) {
    return (
      <div className="jt-row" style={{ paddingLeft: depth * 14 }}>
        <span className="jt-chevron" />
        {name !== null && <span className="jt-key">{name}: </span>}
        <Leaf value={value} />
      </div>
    );
  }

  const entries: [string, unknown][] = Array.isArray(value)
    ? value.map((v, i) => [String(i), v] as [string, unknown])
    : Object.entries(value as Record<string, unknown>);

  return (
    <div>
      <div
        className="jt-row jt-toggle"
        style={{ paddingLeft: depth * 14 }}
        onClick={() => setOpen(!open)}
      >
        <span className="jt-chevron">{open ? "⌄" : "›"}</span>
        {name !== null && <span className="jt-key">{name}: </span>}
        {open ? (
          <span className="jt-brace">{Array.isArray(value) ? "[" : "{"}</span>
        ) : (
          <span className="jt-summary">{summarize(value)}</span>
        )}
      </div>
      {open && (
        <>
          {entries.map(([k, v]) => (
            <JsonNode key={k} name={k} value={v} depth={depth + 1} defaultDepth={defaultDepth} />
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

export default function JsonTree({ value, defaultDepth }: { value: unknown; defaultDepth: number }) {
  return (
    <div className="json-tree">
      <JsonNode name={null} value={value} depth={0} defaultDepth={defaultDepth} />
    </div>
  );
}
