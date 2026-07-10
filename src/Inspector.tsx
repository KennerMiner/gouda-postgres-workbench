import { useState } from "react";
import JsonTree from "./JsonTree";
import { copyText } from "./clipboard";
import type { ColumnMeta } from "./Grid";

// Above this size the tree view gets sluggish; fall back to text.
const TREE_LIMIT = 200_000;

type Props = {
  column: ColumnMeta;
  value: unknown;
  /** Whether the underlying cell may be edited (single table + PK present). */
  editable?: boolean;
  /** Stage a new value for the cell; null = SET NULL. */
  onStage?: (text: string | null) => void;
  onClose: () => void;
};

export default function Inspector({ column, value, editable, onStage, onClose }: Props) {
  // Bumping the key remounts the tree so every node re-seeds from defaultDepth.
  const [treeKey, setTreeKey] = useState(0);
  const [depth, setDepth] = useState(2);
  const [copied, setCopied] = useState("");
  const [editMode, setEditMode] = useState(false);
  const [editText, setEditText] = useState("");
  const [editErr, setEditErr] = useState("");

  const isJson = value !== null && typeof value === "object";
  const isJsonCol = column.typeName === "json" || column.typeName === "jsonb";
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

  const startEdit = () => {
    setEditText(value === null ? "" : isJson ? pretty : String(value));
    setEditErr("");
    setEditMode(true);
  };

  const saveEdit = () => {
    if (isJsonCol) {
      try {
        // Validate and normalize to compact form for the UPDATE.
        onStage?.(JSON.stringify(JSON.parse(editText)));
        return;
      } catch (e) {
        setEditErr(`invalid JSON: ${e}`);
        return;
      }
    }
    onStage?.(editText);
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

      {editMode ? (
        <>
          <div className="inspector-tools">
            <button className="btn mini" onClick={() => setEditMode(false)}>
              Cancel
            </button>
            <span className="spacer" />
            <button className="btn mini danger" onClick={() => onStage?.(null)} title="Stage NULL">
              Set NULL
            </button>
            <button className="btn mini primary" onClick={saveEdit}>
              Stage
            </button>
          </div>
          <div className="inspector-body edit">
            <textarea
              className="inspector-edit"
              autoFocus
              value={editText}
              onChange={(e) => setEditText(e.target.value)}
              spellCheck={false}
            />
            {editErr && <div className="modal-err">{editErr}</div>}
          </div>
        </>
      ) : (
        <>
          <div className="inspector-tools">
            {isJson && (
              <>
                <button className="btn mini" onClick={() => expand(Infinity)}>
                  Expand all
                </button>
                <button className="btn mini" onClick={() => expand(1)}>
                  Collapse
                </button>
              </>
            )}
            <span className="spacer" />
            {editable && onStage && (
              <button className="btn mini" onClick={startEdit}>
                Edit
              </button>
            )}
            {isJson && (
              <button className="btn mini" onClick={() => doCopy(pretty, "pretty")}>
                {copied === "pretty" ? "✓ Copied" : "Copy pretty"}
              </button>
            )}
            <button className="btn mini" onClick={() => doCopy(compact, "compact")}>
              {copied === "compact" ? "✓ Copied" : "Copy"}
            </button>
          </div>
          <div className="inspector-body">
            {treeable ? (
              <JsonTree key={treeKey} value={value} defaultDepth={depth} />
            ) : (
              <pre className="inspector-text">
                {value === null ? "NULL" : isJson ? pretty : String(value)}
              </pre>
            )}
          </div>
        </>
      )}
    </div>
  );
}
