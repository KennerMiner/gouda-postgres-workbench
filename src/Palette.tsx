import { useEffect, useMemo, useRef, useState } from "react";
import { fuzzyScore } from "./fuzzy";

export type PaletteItem = {
  id: string;
  label: string;
  group: string;
  hint?: string;
  /** Selecting the item either acts immediately… */
  run?: () => void;
  /** …or switches the palette into a text-prompt (e.g. "name this snippet"). */
  prompt?: { placeholder: string; submit: (text: string) => void };
};

type Props = { items: PaletteItem[]; onClose: () => void };

const MAX_SHOWN = 40;

export default function Palette({ items, onClose }: Props) {
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const [prompt, setPrompt] = useState<PaletteItem["prompt"] | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const shown = useMemo(() => {
    if (prompt) return [];
    const scored = items
      .map((it) => ({ it, score: fuzzyScore(query, it.label) }))
      .filter((s): s is { it: PaletteItem; score: number } => s.score !== null);
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, MAX_SHOWN).map((s) => s.it);
  }, [items, query, prompt]);

  useEffect(() => setCursor(0), [query]);
  useEffect(() => {
    listRef.current
      ?.querySelector(".palette-item.cursor")
      ?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  const pick = (it: PaletteItem) => {
    if (it.prompt) {
      setPrompt(it.prompt);
      setQuery("");
      return;
    }
    it.run?.();
    onClose();
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      if (prompt) setPrompt(null);
      else onClose();
    } else if (prompt && e.key === "Enter") {
      e.preventDefault();
      if (query.trim()) {
        prompt.submit(query.trim());
        onClose();
      }
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setCursor((c) => Math.min(shown.length - 1, c + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setCursor((c) => Math.max(0, c - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (shown[cursor]) pick(shown[cursor]);
    }
  };

  return (
    <div className="modal-overlay palette-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="palette">
        <input
          className="palette-input"
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKey}
          placeholder={prompt ? prompt.placeholder : "Type a command, table, or snippet…"}
          spellCheck={false}
        />
        {!prompt && (
          <div className="palette-list" ref={listRef}>
            {shown.length === 0 && <div className="palette-empty">No matches</div>}
            {shown.map((it, i) => (
              <div
                key={it.id}
                className={`palette-item ${i === cursor ? "cursor" : ""}`}
                onMouseEnter={() => setCursor(i)}
                onClick={() => pick(it)}
              >
                <span className="palette-group">{it.group}</span>
                <span className="palette-label">{it.label}</span>
                {it.hint && <span className="palette-hint">{it.hint}</span>}
              </div>
            ))}
          </div>
        )}
        {prompt && <div className="palette-empty">↵ to confirm · esc to go back</div>}
      </div>
    </div>
  );
}
