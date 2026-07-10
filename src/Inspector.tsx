import { useState } from "react";
import JsonTree from "./JsonTree";
import type { ColumnMeta } from "./Grid";

/** Clipboard write with WKWebView fallback. */
export async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
}

// Above this size the tree view gets sluggish; fall back to text.
const TREE_LIMIT = 200_000;

type Props = {
  column: ColumnMeta;
  value: unknown;
  onClose: () => void;
};

export default function Inspector({ column, value, onClose }: Props) {
  // Bumping the key remounts the tree so every node re-seeds from defaultDepth.
  const [treeKey, setTreeKey] = useState(0);
  const [depth, setDepth] = useState(2);
  const [copied, setCopied] = useState("");

  const isJson = value !== null && typeof value === "object";
  const compact = isJson ? JSON.stringify(value) : String(value ?? "NULL");
  const pretty = isJson ? JSON.stringify(value, null, 2) : compact;
  const treeable = isJson && compact.length <= TREE_LIMIT;

  const doCopy = async (text: string, label: string) => {
    await copyText(text);
    setCopied(label);
    setTimeout(() => setCopied(""), 1200);
  };

  const expand = (d: number) => {
    setDepth(d);
    setTreeKey((k) => k + 1);
  };

  return (
    <div className="inspector">
      <div className="inspector-head">
        <span className="inspector-col">{column.name}</span>
        <span className="inspector-type">{column.typeName}</span>
        <button className="inspector-close" onClick={onClose} title="Close (Esc)">
          ✕
        </button>
      </div>

      {isJson && (
        <div className="inspector-tools">
          <button className="btn mini" onClick={() => expand(Infinity)}>
            Expand all
          </button>
          <button className="btn mini" onClick={() => expand(1)}>
            Collapse
          </button>
          <span className="spacer" />
          <button className="btn mini" onClick={() => doCopy(pretty, "pretty")}>
            {copied === "pretty" ? "✓ Copied" : "Copy pretty"}
          </button>
          <button className="btn mini" onClick={() => doCopy(compact, "compact")}>
            {copied === "compact" ? "✓ Copied" : "Copy"}
          </button>
        </div>
      )}
      {!isJson && (
        <div className="inspector-tools">
          <span className="spacer" />
          <button className="btn mini" onClick={() => doCopy(compact, "compact")}>
            {copied === "compact" ? "✓ Copied" : "Copy"}
          </button>
        </div>
      )}

      <div className="inspector-body">
        {treeable ? (
          <JsonTree key={treeKey} value={value} defaultDepth={depth} />
        ) : (
          <pre className="inspector-text">
            {value === null ? "NULL" : isJson ? pretty : String(value)}
          </pre>
        )}
      </div>
    </div>
  );
}
