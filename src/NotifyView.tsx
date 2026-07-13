import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

type PgNotify = { connId: number; channel: string; payload: string; pid: number };
type LoggedEvent = PgNotify & { ts: number };

export default function NotifyView({ connId }: { connId: number }) {
  const [channels, setChannels] = useState<string[]>([]);
  const [input, setInput] = useState("");
  const [events, setEvents] = useState<LoggedEvent[]>([]);
  const [error, setError] = useState("");
  const [sendChannel, setSendChannel] = useState("");
  const [sendPayload, setSendPayload] = useState("");
  const channelsRef = useRef(channels);
  channelsRef.current = channels;

  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    listen<PgNotify>("pg-notify", (e) => {
      if (e.payload.connId !== connId) return;
      setEvents((prev) => [{ ...e.payload, ts: Date.now() }, ...prev].slice(0, 500));
    }).then((u) => (unlisten = u));
    return () => {
      unlisten?.();
      // Leave no ghost LISTENs behind when the console closes.
      for (const ch of channelsRef.current) {
        invoke("listen_stop", { connId, channel: ch }).catch(() => {});
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connId]);

  const subscribe = async () => {
    const ch = input.trim();
    if (!ch || channels.includes(ch)) return;
    setError("");
    try {
      await invoke("listen_start", { connId, channel: ch });
      setChannels((prev) => [...prev, ch]);
      setInput("");
      if (!sendChannel) setSendChannel(ch);
    } catch (e) {
      setError(String(e));
    }
  };

  const unsubscribe = async (ch: string) => {
    try {
      await invoke("listen_stop", { connId, channel: ch });
    } finally {
      setChannels((prev) => prev.filter((c) => c !== ch));
    }
  };

  const send = async () => {
    const ch = sendChannel.trim() || channels[0];
    if (!ch) return;
    setError("");
    try {
      await invoke("notify_send", { connId, channel: ch, payload: sendPayload });
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <div className="notify-view">
      <div className="notify-row">
        <input
          className="filter notify-input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && subscribe()}
          placeholder="channel name (e.g. cache_invalidation)"
          spellCheck={false}
        />
        <button className="btn mini primary" onClick={subscribe} disabled={!input.trim()}>
          Listen
        </button>
        <span className="spacer" />
        {channels.map((ch) => (
          <span key={ch} className="notify-chip">
            {ch}
            <span className="tab-close" onClick={() => unsubscribe(ch)} style={{ visibility: "visible" }}>
              ×
            </span>
          </span>
        ))}
        {channels.length === 0 && <span className="ai-ctx-sub">not listening to any channels</span>}
      </div>

      <div className="notify-row">
        <input
          className="filter notify-send-ch"
          value={sendChannel}
          onChange={(e) => setSendChannel(e.target.value)}
          placeholder="channel"
          spellCheck={false}
        />
        <input
          className="filter notify-input"
          value={sendPayload}
          onChange={(e) => setSendPayload(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && send()}
          placeholder="payload — sends NOTIFY from this connection"
          spellCheck={false}
        />
        <button className="btn mini" onClick={send} disabled={!(sendChannel.trim() || channels.length)}>
          Send
        </button>
      </div>

      {error && <div className="modal-err">{error}</div>}

      <div className="notify-log">
        {events.length === 0 && (
          <div className="tree-empty">
            events appear here — try listening to a channel, then Send yourself a test message
          </div>
        )}
        {events.map((e, i) => (
          <div key={i} className="notify-event">
            <span className="notify-ts">{new Date(e.ts).toLocaleTimeString()}</span>
            <span className="notify-chan">{e.channel}</span>
            <span className="notify-payload">{e.payload || "(empty)"}</span>
            <span className="notify-pid">pid {e.pid}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
