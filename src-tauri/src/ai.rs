//! "Ask AI" query generation and schema exploration, via a local AI CLI.
//!
//! Three harnesses are supported — Claude Code (`claude`), Codex (`codex`),
//! and opencode (`opencode`) — so users work with whatever they already have
//! set up. The provider is a stored preference (auto-detected on first use).
//!
//! Per-profile context lives as an `AGENTS.md` in an app-data directory used
//! as the CLI's working dir; all three harnesses read AGENTS.md as project
//! memory. (Claude Code also reads CLAUDE.md — kept as a load fallback.)

use std::path::PathBuf;
use tauri::Manager;
use tokio::process::Command;

use crate::store::{state_get_inner, state_set_inner, Store};

/// (id, display label, binary name). Order = auto-detect preference.
const PROVIDERS: [(&str, &str); 3] = [("claude", "Claude Code"), ("codex", "Codex"), ("opencode", "opencode")];

fn is_available(bin: &str) -> bool {
    std::process::Command::new("/bin/zsh")
        .arg("-lc")
        .arg(format!("command -v {bin}"))
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Current provider id: the stored preference if still valid, else the first
/// installed one, else "claude".
fn current_provider(store: &Store) -> String {
    if let Ok(Some(saved)) = state_get_inner(store, "ai_provider") {
        if PROVIDERS.iter().any(|(id, _)| *id == saved) {
            return saved;
        }
    }
    PROVIDERS
        .iter()
        .find(|(id, _)| is_available(id))
        .map(|(id, _)| id.to_string())
        .unwrap_or_else(|| "claude".into())
}

/// Shell command (argument to `zsh -lc`) for a provider. The prompt is read
/// from $PSQLV_PROMPT to avoid shell-quoting hazards.
///
/// Generation (`explore = false`) never runs shell commands, so it carries no
/// permission flags. Exploration needs the agent to run `psql`:
///   - Claude Code uses a *scoped* allowlist (`Bash(psql:*)`) — safe, always on.
///   - Codex / opencode have no scoped equivalent for non-interactive runs;
///     they need a full sandbox bypass, so exploration is gated on the
///     user-set `ai_allow_bypass` opt-in (see `bypass_required` / callers).
fn provider_command(id: &str, explore: bool) -> &'static str {
    match (id, explore) {
        ("codex", false) => r#"codex exec --skip-git-repo-check "$PSQLV_PROMPT""#,
        ("codex", true) => {
            r#"codex exec --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox "$PSQLV_PROMPT""#
        }
        ("opencode", false) => r#"opencode run --format json "$PSQLV_PROMPT""#,
        ("opencode", true) => {
            r#"opencode run --format json --dangerously-skip-permissions "$PSQLV_PROMPT""#
        }
        (_, false) => r#"claude -p "$PSQLV_PROMPT""#,
        (_, true) => r#"claude -p "$PSQLV_PROMPT" --allowedTools "Bash(psql:*)""#,
    }
}

/// Whether this provider's exploration needs the sandbox-bypass opt-in.
/// Claude Code's scoped allowlist doesn't; the others do.
fn bypass_required(id: &str) -> bool {
    id == "codex" || id == "opencode"
}

fn bypass_enabled(store: &Store) -> bool {
    state_get_inner(store, "ai_allow_bypass")
        .ok()
        .flatten()
        .as_deref()
        == Some("true")
}

/// opencode emits a stream of JSON events on stdout; pull the assistant text
/// parts out of it. Defensive: any `{"type":"text","text":...}` node counts,
/// tried as one JSON doc then as JSON-lines, with raw stdout as a fallback.
fn extract_opencode(stdout: &str) -> String {
    fn walk(v: &serde_json::Value, out: &mut String) {
        match v {
            serde_json::Value::Object(m) => {
                if m.get("type").and_then(|t| t.as_str()) == Some("text") {
                    if let Some(s) = m.get("text").and_then(|t| t.as_str()) {
                        out.push_str(s);
                        return;
                    }
                }
                for val in m.values() {
                    walk(val, out);
                }
            }
            serde_json::Value::Array(a) => {
                for val in a {
                    walk(val, out);
                }
            }
            _ => {}
        }
    }
    let mut out = String::new();
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(stdout) {
        walk(&v, &mut out);
    } else {
        for line in stdout.lines() {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(line.trim()) {
                walk(&v, &mut out);
            }
        }
    }
    if out.trim().is_empty() {
        stdout.to_string()
    } else {
        out
    }
}

fn extract_output(id: &str, stdout: &str) -> String {
    let raw = if id == "opencode" {
        extract_opencode(stdout)
    } else {
        stdout.to_string()
    };
    strip_fences(&raw)
}

/// Models sometimes wrap output in markdown fences despite instructions.
fn strip_fences(s: &str) -> String {
    let t = s.trim();
    for prefix in ["```sql", "```"] {
        if let Some(inner) = t.strip_prefix(prefix) {
            if let Some(end) = inner.rfind("```") {
                return inner[..end].trim().to_string();
            }
        }
    }
    t.to_string()
}

/// Per-profile working dir for the CLI; its AGENTS.md is the explored context.
fn ctx_dir(app: &tauri::AppHandle, profile_id: i64) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("ai")
        .join(profile_id.to_string());
    std::fs::create_dir_all(&dir).map_err(|e| format!("ai dir: {e}"))?;
    Ok(dir)
}

// --- provider preference commands -------------------------------------------

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderInfo {
    id: String,
    label: String,
    available: bool,
    current: bool,
}

#[tauri::command]
pub fn ai_providers(store: tauri::State<'_, Store>) -> Result<Vec<ProviderInfo>, String> {
    let cur = current_provider(&store);
    Ok(PROVIDERS
        .iter()
        .map(|(id, label)| ProviderInfo {
            id: id.to_string(),
            label: label.to_string(),
            available: is_available(id),
            current: *id == cur,
        })
        .collect())
}

#[tauri::command]
pub fn ai_set_provider(store: tauri::State<'_, Store>, provider: String) -> Result<(), String> {
    if !PROVIDERS.iter().any(|(id, _)| *id == provider) {
        return Err(format!("unknown provider: {provider}"));
    }
    state_set_inner(&store, "ai_provider", &provider)
}

/// The opt-in for running Codex/opencode exploration without sandboxing.
#[tauri::command]
pub fn ai_get_bypass(store: tauri::State<'_, Store>) -> Result<bool, String> {
    Ok(bypass_enabled(&store))
}

#[tauri::command]
pub fn ai_set_bypass(store: tauri::State<'_, Store>, enabled: bool) -> Result<(), String> {
    state_set_inner(&store, "ai_allow_bypass", if enabled { "true" } else { "false" })
}

// --- context file -----------------------------------------------------------

#[tauri::command]
pub fn ai_load_context(app: tauri::AppHandle, profile_id: i64) -> Result<Option<String>, String> {
    let dir = ctx_dir(&app, profile_id)?;
    for name in ["AGENTS.md", "CLAUDE.md"] {
        match std::fs::read_to_string(dir.join(name)) {
            Ok(s) => return Ok(Some(s)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(e) => return Err(format!("read context: {e}")),
        }
    }
    Ok(None)
}

#[tauri::command]
pub fn ai_save_context(app: tauri::AppHandle, profile_id: i64, text: String) -> Result<(), String> {
    let path = ctx_dir(&app, profile_id)?.join("AGENTS.md");
    std::fs::write(&path, text).map_err(|e| format!("write context: {e}"))
}

// --- generation -------------------------------------------------------------

#[tauri::command]
pub async fn ai_generate_query(
    app: tauri::AppHandle,
    store: tauri::State<'_, Store>,
    profile_id: i64,
    prompt: String,
    context: String,
) -> Result<String, String> {
    let provider = current_provider(&store);
    let full = format!(
        "Using the PostgreSQL schema and sample data below (plus your AGENTS.md notes about \
         this database, if present), write a single PostgreSQL query for this request: {prompt}\n\
         Respond with ONLY SQL — no markdown fences, no prose outside SQL comments. \
         Start with a short block of '--' comments explaining the approach, then the query \
         itself with brief inline '--' comments on non-obvious parts. \
         Use only tables and columns that exist in the provided schema.\n\n{context}"
    );

    // zsh -lc: GUI apps get a minimal PATH; a login shell finds the CLI.
    // cwd = the profile's context dir so its AGENTS.md loads as project memory.
    let out = Command::new("/bin/zsh")
        .arg("-lc")
        .arg(provider_command(&provider, false))
        .env("PSQLV_PROMPT", &full)
        .current_dir(ctx_dir(&app, profile_id)?)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("failed to launch {provider}: {e}"))?
        .wait_with_output();
    let out = tokio::time::timeout(std::time::Duration::from_secs(180), out)
        .await
        .map_err(|_| format!("{provider} timed out after 180s"))?
        .map_err(|e| format!("{provider}: {e}"))?;

    let stderr = String::from_utf8_lossy(&out.stderr);
    eprintln!(
        "[ai] generate ({provider}): status={} stdout={}B stderr={}B",
        out.status,
        out.stdout.len(),
        out.stderr.len()
    );
    if !out.status.success() {
        return Err(format!("{provider} failed ({}): {}", out.status, stderr.trim()));
    }

    let sql = extract_output(&provider, &String::from_utf8_lossy(&out.stdout));
    if sql.trim().is_empty() {
        return Err(format!(
            "{provider} returned no usable output.{}",
            if stderr.trim().is_empty() {
                String::new()
            } else {
                format!("\n\n{}", stderr.trim())
            }
        ));
    }
    Ok(sql)
}

// --- exploration ------------------------------------------------------------

/// Agentic schema exploration: the CLI gets `psql` (read-only session via
/// PGOPTIONS) preconfigured through env vars — the password never appears in
/// any prompt or command line — and writes a reference document (AGENTS.md)
/// about what the data actually means. Tunnel-aware for SSH profiles.
#[tauri::command]
pub async fn ai_explore_context(
    app: tauri::AppHandle,
    store: tauri::State<'_, Store>,
    profile_id: i64,
    guidance: String,
    schema: String,
) -> Result<String, String> {
    let provider = current_provider(&store);
    if bypass_required(&provider) && !bypass_enabled(&store) {
        let label = PROVIDERS
            .iter()
            .find(|(id, _)| *id == provider)
            .map(|(_, l)| *l)
            .unwrap_or(&provider);
        return Err(format!(
            "Database exploration with {label} runs shell commands without sandboxing. \
             Enable “Allow AI shell access (Codex / opencode)” from the command palette \
             to opt in. (Claude Code's exploration is scoped to psql and needs no bypass.)"
        ));
    }
    let (profile, password) = crate::profiles::load_profile_with_password(&store, profile_id)?;

    // Keep the tunnel alive for the whole exploration.
    let mut _tunnel: Option<crate::tunnel::Tunnel> = None;
    let (host, port) = if profile.ssh_enabled {
        let key_path = profile.ssh_key_path.trim();
        let t = crate::tunnel::open(
            crate::tunnel::SshParams {
                host: profile.ssh_host.clone(),
                port: profile.ssh_port,
                user: profile.ssh_user.clone(),
                key_path: if key_path.is_empty() {
                    None
                } else {
                    Some(key_path.replacen('~', &std::env::var("HOME").unwrap_or_default(), 1))
                },
            },
            profile.host.clone(),
            profile.port,
        )
        .await?;
        let p = t.local_port;
        _tunnel = Some(t);
        ("127.0.0.1".to_string(), p)
    } else {
        (profile.host.clone(), profile.port)
    };

    let extra = if guidance.trim().is_empty() {
        String::new()
    } else {
        format!("\nThe user adds this guidance: {guidance}\n")
    };
    let full = format!(
        "You have READ-ONLY access to a PostgreSQL database through the `psql` command — \
         the connection is preconfigured via environment variables, so just run \
         `psql -c \"...\"`. Explore the database to understand what the data MEANS, not \
         just its shape: sample rows from the important tables (limit 5), check distinct \
         values of enum-like/status columns, follow foreign keys, peek inside JSON \
         payloads. The schema catalog is provided below as a starting point. If an \
         AGENTS.md already exists in your working directory from a previous exploration, \
         refine and extend it rather than starting over.{extra}\n\
         Then output ONLY a concise markdown reference document (under 250 lines) covering: \
         each significant table's purpose, key columns and their meanings, relationships, \
         discovered enum/status values and what they appear to mean, JSON payload shapes, \
         and gotchas (soft deletes, units, denormalizations). This document becomes the \
         AGENTS.md that a query-writing AI reads later — optimize for that reader.\n\n\
         === SCHEMA ===\n{schema}"
    );

    let dir = ctx_dir(&app, profile_id)?;
    let mut cmd = Command::new("/bin/zsh");
    cmd.arg("-lc")
        .arg(provider_command(&provider, true))
        .env("PSQLV_PROMPT", &full)
        .current_dir(&dir)
        .env("PGHOST", &host)
        .env("PGPORT", port.to_string())
        .env("PGUSER", &profile.username)
        .env("PGDATABASE", &profile.dbname)
        .env("PGOPTIONS", "-c default_transaction_read_only=on")
        .env("PGCONNECT_TIMEOUT", "10")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    if let Some(pw) = &password {
        cmd.env("PGPASSWORD", pw);
    }
    let out = cmd
        .spawn()
        .map_err(|e| format!("failed to launch {provider}: {e}"))?
        .wait_with_output();
    let out = tokio::time::timeout(std::time::Duration::from_secs(600), out)
        .await
        .map_err(|_| "exploration timed out after 10 minutes".to_string())?
        .map_err(|e| format!("{provider}: {e}"))?;

    let stderr = String::from_utf8_lossy(&out.stderr);
    eprintln!(
        "[ai] explore ({provider}): status={} stdout={}B stderr={}B",
        out.status,
        out.stdout.len(),
        out.stderr.len()
    );
    if !out.status.success() {
        return Err(format!("{provider} failed ({}): {}", out.status, stderr.trim()));
    }
    let doc = extract_output(&provider, &String::from_utf8_lossy(&out.stdout));
    if doc.trim().is_empty() {
        return Err(format!(
            "exploration returned no output.{}",
            if stderr.trim().is_empty() {
                String::new()
            } else {
                format!("\n\n{}", stderr.trim())
            }
        ));
    }
    // Persist as AGENTS.md — future ai_generate_query calls run with this
    // directory as cwd and pick it up automatically.
    std::fs::write(dir.join("AGENTS.md"), &doc).map_err(|e| format!("write context: {e}"))?;
    Ok(doc)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_fences() {
        assert_eq!(strip_fences("```sql\nselect 1;\n```"), "select 1;");
        assert_eq!(strip_fences("```\nselect 1;\n```"), "select 1;");
        assert_eq!(strip_fences("select 1;"), "select 1;");
        assert_eq!(strip_fences("-- note\nselect 1;"), "-- note\nselect 1;");
    }

    #[test]
    fn provider_commands_are_distinct() {
        assert!(provider_command("claude", false).starts_with("claude -p"));
        assert!(provider_command("codex", false).contains("codex exec --skip-git-repo-check"));
        assert!(provider_command("codex", true).contains("--dangerously-bypass-approvals-and-sandbox"));
        assert!(provider_command("opencode", false).contains("opencode run --format json"));
        assert!(provider_command("opencode", true).contains("--dangerously-skip-permissions"));
        assert!(provider_command("claude", true).contains("--allowedTools"));
    }

    #[test]
    fn opencode_extracts_text_parts() {
        // one JSON doc
        let one = r#"{"parts":[{"type":"text","text":"select 1;"}]}"#;
        assert_eq!(extract_opencode(one).trim(), "select 1;");
        // json-lines with a tool event and a text event
        let lines = "{\"type\":\"tool\",\"name\":\"bash\"}\n{\"type\":\"text\",\"text\":\"select 2;\"}";
        assert_eq!(extract_opencode(lines).trim(), "select 2;");
        // unparseable → raw fallback
        assert_eq!(extract_opencode("select 3;").trim(), "select 3;");
    }
}
