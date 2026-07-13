import { useState } from "react";

type Props = {
  /** Exploration in flight vs document ready for review. */
  phase: "exploring" | "ready";
  text: string;
  error: string;
  profileName: string;
  onSave: (text: string) => void;
  onClose: () => void;
};

export default function AiContextModal({ phase, text, error, profileName, onSave, onClose }: Props) {
  const [draft, setDraft] = useState(text);

  return (
    <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && phase === "ready" && onClose()}>
      <div className="ai-ctx-modal">
        <div className="ai-ctx-head">
          <span className="ai-ctx-title">✦ AI database context — {profileName}</span>
          <span className="ai-ctx-sub">included in every Ask-AI request for this connection</span>
        </div>
        {phase === "exploring" ? (
          <div className="ai-ctx-exploring">
            <span className="tab-spinner">●</span> Claude is exploring the database (read-only)…
            <div className="ai-ctx-sub">sampling tables, checking enums, following relationships — a few minutes</div>
          </div>
        ) : (
          <>
            {error && <div className="modal-err">{error}</div>}
            <textarea
              className="ai-ctx-text"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="No context yet — run Initialize AI context, or write notes about your data here by hand."
              spellCheck={false}
            />
            <div className="modal-actions">
              <span className="ai-ctx-sub">edit freely — it's your document</span>
              <span className="spacer" />
              <button className="btn" onClick={onClose}>
                Discard
              </button>
              <button className="btn primary" onClick={() => onSave(draft)}>
                Save
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
