import { useMemo, useState } from "react";
import JsonTree, { computeKeep, pgPath, type Path } from "./JsonTree";
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
  /** Stage a single-node edit (jsonb_set); value is a JSON literal. */
  onStageJsonSet?: (path: Path, value: string) => void;
  onClose: () => void;
};

type NodeEdit = { path: Path; text: string; err: string };

export default function Inspector({
  column,
  value,
  editable,
  onStage,
  onStageJsonSet,
  onClose,
}: Props) {
  // Bumping the key remounts the tree so every node re-seeds from defaultDepth.
  const [treeKey, setTreeKey] = useState(0);
  const [depth, setDepth] = useState(2);
  const [copied, setCopied] = useState("");
  const [editMode, setEditMode] = useState(false);
  const [editText, setEditText] = useState("");
  const [editErr, setEditErr] = useState("");
  const [filter, setFilter] = useState("");
  const [nodeEdit, setNodeEdit] = useState<NodeEdit | null>(null);

  const stageNode = () => {
    if (!nodeEdit || !onStageJsonSet) return;
    try {
      // Normalize (and validate) the JSON literal before staging.
      onStageJsonSet(nodeEdit.path, JSON.stringify(JSON.parse(nodeEdit.text)));
      setNodeEdit(null);
    } catch (e) {
      setNodeEdit({ ...nodeEdit, err: `invalid JSON: ${e}` });
    }
  };

  const isJson = value !== null && typeof value === "object";
  const isJsonCol = column.typeName === "json" || column.typeName === "jsonb";
  const compact = isJson ? JSON.stringify(value) : String(value ?? "NULL");
  const pretty = isJson ? JSON.stringify(value, null, 2) : compact;
  const treeable = isJson && compact.length <= TREE_LIMIT;

  const trimmedFilter = filter.trim();
  const filtered = useMemo(
    () => (treeable && trimmedFilter ? computeKeep(value, trimmedFilter) : null),
    [treeable, value, trimmedFilter],
  );

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
          {nodeEdit && (
            <div className="node-edit">
              <div className="node-edit-path">{pgPath(column.name, nodeEdit.path, false)}</div>
              <textarea
                className="inspector-edit node-edit-text"
                autoFocus
                value={nodeEdit.text}
                onChange={(e) => setNodeEdit({ ...nodeEdit, text: e.target.value, err: "" })}
                onKeyDown={(e) => {
                  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                    e.preventDefault();
                    stageNode();
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    setNodeEdit(null);
                  }
                }}
                spellCheck={false}
              />
              {nodeEdit.err && <div className="modal-err">{nodeEdit.err}</div>}
              <div className="node-edit-actions">
                <span className="node-edit-hint">JSON literal · ⌘↵ stages</span>
                <span className="spacer" />
                <button className="btn mini" onClick={() => setNodeEdit(null)}>
                  Cancel
                </button>
                <button className="btn mini primary" onClick={stageNode}>
                  Stage node
                </button>
              </div>
            </div>
          )}
          {treeable && (
            <div className="jt-filter-row">
              <input
                className="jt-filter"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="Filter keys & values…"
                spellCheck={false}
              />
              {filtered && (
                <span className="jt-matches">
                  {filtered.matches} match{filtered.matches === 1 ? "" : "es"}
                </span>
              )}
            </div>
          )}
          <div className="inspector-body">
            {treeable ? (
              filtered && filtered.matches === 0 ? (
                <div className="jt-nomatch">No matches</div>
              ) : (
                <JsonTree
                  key={treeKey}
                  value={value}
                  defaultDepth={depth}
                  column={column.name}
                  filter={trimmedFilter}
                  keep={filtered ? filtered.keep : null}
                  onEditNode={
                    onStageJsonSet
                      ? (path, current) =>
                          setNodeEdit({
                            path,
                            text: JSON.stringify(current, null, 2),
                            err: "",
                          })
                      : undefined
                  }
                />
              )
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
