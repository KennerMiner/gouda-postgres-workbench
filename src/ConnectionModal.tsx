import { useEffect, useState } from "react";

export type Profile = {
  id: number | null;
  name: string;
  host: string;
  port: number;
  dbname: string;
  username: string;
  color: string;
  lastUsedAt: number | null;
  sshEnabled: boolean;
  sshHost: string;
  sshPort: number;
  sshUser: string;
  /** Empty = SSH agent / default key files. */
  sshKeyPath: string;
  /** Sessions open with default_transaction_read_only = on. */
  readOnly: boolean;
  /** "disable" | "require" | "verify-full". */
  sslMode: string;
};

export const PROFILE_COLORS = ["green", "blue", "purple", "amber", "red"] as const;

const BLANK: Profile = {
  id: null,
  name: "",
  host: "localhost",
  port: 5432,
  dbname: "",
  username: "",
  color: "green",
  lastUsedAt: null,
  sshEnabled: false,
  sshHost: "",
  sshPort: 22,
  sshUser: "",
  sshKeyPath: "",
  readOnly: false,
  sslMode: "disable",
};

type Props = {
  profiles: Profile[];
  activeId: number | null;
  /** Persists the profile and returns it with its id filled in. */
  onSave: (profile: Profile, password: string | null) => Promise<Profile>;
  onDelete: (profileId: number) => Promise<void>;
  onConnect: (profile: Profile) => Promise<unknown>;
  /** Tries the form values without switching connection; resolves to server version. */
  onTest: (profile: Profile, password: string | null) => Promise<string>;
  onClose: () => void;
};

export default function ConnectionModal({
  profiles,
  activeId,
  onSave,
  onDelete,
  onConnect,
  onTest,
  onClose,
}: Props) {
  const [form, setForm] = useState<Profile>(profiles[0] ?? BLANK);
  // Password is write-only: empty string means "leave unchanged" on save.
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [testResult, setTestResult] = useState<{ ok: boolean; msg: string } | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const pick = (p: Profile) => {
    setForm(p);
    setPassword("");
    setErr("");
    setTestResult(null);
  };

  const set = <K extends keyof Profile>(k: K, v: Profile[K]) => {
    setForm({ ...form, [k]: v });
    setTestResult(null); // stale test verdicts mislead
  };

  const guard = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setErr("");
    try {
      await fn();
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  };

  const test = () =>
    guard(async () => {
      try {
        const version = await onTest(form, password || null);
        setTestResult({ ok: true, msg: `✓ ${version}` });
      } catch (e) {
        setTestResult({ ok: false, msg: `✗ ${e}` });
      }
    });

  const save = () =>
    guard(async () => {
      const saved = await onSave(form, password || null);
      setForm(saved);
      setPassword("");
    });
  const connect = () =>
    guard(async () => {
      const saved = await onSave(form, password || null);
      setForm(saved);
      setPassword("");
      await onConnect(saved);
    });

  return (
    <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <div className="modal-side">
          <div className="modal-side-head">Connections</div>
          <div className="modal-list">
            {profiles.map((p) => (
              <div
                key={p.id}
                className={`modal-item ${form.id === p.id ? "picked" : ""}`}
                onClick={() => pick(p)}
                onDoubleClick={() => {
                  pick(p);
                  guard(() => onConnect(p));
                }}
              >
                <span className={`dot c-${p.color}`} />
                <span className="modal-item-name">{p.name}</span>
                {p.id === activeId && <span className="live">●</span>}
              </div>
            ))}
          </div>
          <button className="btn modal-new" onClick={() => pick({ ...BLANK })}>
            + New
          </button>
        </div>

        <div className="modal-form">
          <label>
            Name
            <input value={form.name} onChange={(e) => set("name", e.target.value)} spellCheck={false} />
          </label>
          <div className="form-row">
            <label className="grow">
              Host
              <input value={form.host} onChange={(e) => set("host", e.target.value)} spellCheck={false} />
            </label>
            <label className="port">
              Port
              <input
                value={form.port}
                onChange={(e) => set("port", Number(e.target.value.replace(/\D/g, "")) || 0)}
                spellCheck={false}
              />
            </label>
          </div>
          <label>
            Database
            <input value={form.dbname} onChange={(e) => set("dbname", e.target.value)} spellCheck={false} />
          </label>
          <label>
            User
            <input value={form.username} onChange={(e) => set("username", e.target.value)} spellCheck={false} />
          </label>
          <label>
            Password
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={form.id !== null ? "•••••• (unchanged)" : ""}
            />
          </label>
          <label>
            SSL
            <select
              className="ssl-select"
              value={form.sslMode}
              onChange={(e) => set("sslMode", e.target.value)}
            >
              <option value="disable">disable — plaintext (local / SSH tunnel)</option>
              <option value="require">require — encrypted, no cert check (RDS etc.)</option>
              <option value="verify-full">verify-full — encrypted + system trust store</option>
            </select>
          </label>
          <label className="ssh-toggle">
            <span className="ssh-toggle-row">
              <input
                type="checkbox"
                checked={form.readOnly}
                onChange={(e) => set("readOnly", e.target.checked)}
              />
              Open read-only
            </span>
          </label>
          <label className="ssh-toggle">
            <span className="ssh-toggle-row">
              <input
                type="checkbox"
                checked={form.sshEnabled}
                onChange={(e) => set("sshEnabled", e.target.checked)}
              />
              Connect via SSH tunnel
            </span>
          </label>
          {form.sshEnabled && (
            <div className="ssh-fields">
              <div className="form-row">
                <label className="grow">
                  SSH host
                  <input
                    value={form.sshHost}
                    onChange={(e) => set("sshHost", e.target.value)}
                    spellCheck={false}
                  />
                </label>
                <label className="port">
                  Port
                  <input
                    value={form.sshPort}
                    onChange={(e) => set("sshPort", Number(e.target.value.replace(/\D/g, "")) || 0)}
                    spellCheck={false}
                  />
                </label>
              </div>
              <label>
                SSH user
                <input
                  value={form.sshUser}
                  onChange={(e) => set("sshUser", e.target.value)}
                  spellCheck={false}
                />
              </label>
              <label>
                Key file
                <input
                  value={form.sshKeyPath}
                  onChange={(e) => set("sshKeyPath", e.target.value)}
                  placeholder="ssh agent / default keys"
                  spellCheck={false}
                />
              </label>
            </div>
          )}

          <div className="color-row">
            {PROFILE_COLORS.map((c) => (
              <span
                key={c}
                className={`swatch c-${c} ${form.color === c ? "picked" : ""}`}
                onClick={() => set("color", c)}
                title={c}
              />
            ))}
            <span className="color-hint">banner color</span>
          </div>

          {err && <div className="modal-err">{err}</div>}
          {testResult && (
            <div className={`test-result ${testResult.ok ? "ok" : "fail"}`}>{testResult.msg}</div>
          )}

          <div className="modal-actions">
            {form.id !== null && (
              <button
                className="btn danger"
                disabled={busy}
                onClick={() => guard(() => onDelete(form.id!))}
              >
                Delete
              </button>
            )}
            <button
              className="btn"
              disabled={
                busy ||
                !form.host ||
                !form.dbname ||
                !form.username ||
                (form.sshEnabled && (!form.sshHost || !form.sshUser))
              }
              onClick={test}
            >
              {busy ? "…" : "Test"}
            </button>
            <span className="spacer" />
            <button className="btn" disabled={busy || !form.name} onClick={save}>
              Save
            </button>
            <button
              className="btn primary"
              disabled={
                busy ||
                !form.name ||
                !form.dbname ||
                !form.username ||
                (form.sshEnabled && (!form.sshHost || !form.sshUser))
              }
              onClick={connect}
            >
              {busy ? "Connecting…" : "Connect"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
