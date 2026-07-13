//! "Ask AI" query generation, provider: the `claude` CLI (uses the user's
//! existing Claude Code login — no API key to manage). The provider seam is
//! this one command; an Anthropic-API backend can slot in later.
//!
//! Per-profile context lives as a real CLAUDE.md in an app-data directory
//! used as the CLI's cwd — claude picks it up natively as project memory.

use std::path::PathBuf;
use tauri::Manager;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;

/// Per-profile working dir for the claude CLI; its CLAUDE.md is the explored
/// database context.
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

#[tauri::command]
pub fn ai_load_context(app: tauri::AppHandle, profile_id: i64) -> Result<Option<String>, String> {
    let path = ctx_dir(&app, profile_id)?.join("CLAUDE.md");
    match std::fs::read_to_string(&path) {
        Ok(s) => Ok(Some(s)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("read context: {e}")),
    }
}

#[tauri::command]
pub fn ai_save_context(app: tauri::AppHandle, profile_id: i64, text: String) -> Result<(), String> {
    let path = ctx_dir(&app, profile_id)?.join("CLAUDE.md");
    std::fs::write(&path, text).map_err(|e| format!("write context: {e}"))
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

#[tauri::command]
pub async fn ai_generate_query(
    app: tauri::AppHandle,
    profile_id: i64,
    prompt: String,
    context: String,
) -> Result<String, String> {
    let instruction = format!(
        "Using the PostgreSQL schema and sample data provided on stdin (plus your CLAUDE.md \
         notes about this database, if present), write a single PostgreSQL query for this \
         request: {prompt}\n\
         Respond with ONLY SQL — no markdown fences, no prose outside SQL comments. \
         Start with a short block of '--' comments explaining the approach, then the query \
         itself with brief inline '--' comments on non-obvious parts. \
         Use only tables and columns that exist in the provided schema."
    );

    // zsh -lc: GUI apps get a minimal PATH; a login shell finds `claude`.
    // The instruction travels in an env var to avoid shell-quoting hazards.
    // cwd = the profile's context dir so its CLAUDE.md loads as project memory.
    let mut child = Command::new("/bin/zsh")
        .arg("-lc")
        .arg(r#"claude -p "$PSQLV_INSTRUCTION""#)
        .env("PSQLV_INSTRUCTION", &instruction)
        .current_dir(ctx_dir(&app, profile_id)?)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("failed to launch claude CLI: {e}"))?;

    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(context.as_bytes())
            .await
            .map_err(|e| format!("claude stdin: {e}"))?;
        // Dropping stdin closes the pipe so the CLI stops reading.
    }

    let out = tokio::time::timeout(
        std::time::Duration::from_secs(180),
        child.wait_with_output(),
    )
    .await
    .map_err(|_| "claude CLI timed out after 180s".to_string())?
    .map_err(|e| format!("claude CLI: {e}"))?;

    eprintln!(
        "[ai] generate: status={} stdout={}B stderr={}B",
        out.status,
        out.stdout.len(),
        out.stderr.len()
    );
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        eprintln!("[ai] generate stderr: {}", stderr.trim());
        return Err(format!(
            "claude CLI failed ({}): {}",
            out.status,
            stderr.trim()
        ));
    }

    let sql = strip_fences(&String::from_utf8_lossy(&out.stdout));
    if sql.trim().is_empty() {
        return Err("claude returned no output".into());
    }
    Ok(sql)
}

/// Agentic schema exploration: claude gets `psql` (read-only session via
/// PGOPTIONS) preconfigured through env vars — the password never appears in
/// any prompt or command line — and writes a reference document about what
/// the data actually means. Tunnel-aware for SSH profiles.
#[tauri::command]
pub async fn ai_explore_context(
    app: tauri::AppHandle,
    store: tauri::State<'_, crate::store::Store>,
    profile_id: i64,
    guidance: String,
    schema: String,
) -> Result<String, String> {
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
    let instruction = format!(
        "You have READ-ONLY access to a PostgreSQL database through the `psql` command — \
         the connection is preconfigured via environment variables, so just run \
         `psql -c \"...\"`. Explore the database to understand what the data MEANS, not \
         just its shape: sample rows from the important tables (limit 5), check distinct \
         values of enum-like/status columns, follow foreign keys, peek inside JSON \
         payloads. The schema catalog is provided on stdin as a starting point. If a \
         CLAUDE.md already exists in your working directory from a previous exploration, \
         refine and extend it rather than starting over.{extra}\n\
         Then output ONLY a concise markdown reference document (under 250 lines) covering: \
         each significant table's purpose, key columns and their meanings, relationships, \
         discovered enum/status values and what they appear to mean, JSON payload shapes, \
         and gotchas (soft deletes, units, denormalizations). This document becomes the \
         CLAUDE.md that a query-writing AI reads later — optimize for that reader."
    );

    let dir = ctx_dir(&app, profile_id)?;
    let mut cmd = Command::new("/bin/zsh");
    cmd.arg("-lc")
        .arg(r#"claude -p "$PSQLV_INSTRUCTION" --allowedTools "Bash(psql:*)""#)
        .env("PSQLV_INSTRUCTION", &instruction)
        .current_dir(&dir)
        .env("PGHOST", &host)
        .env("PGPORT", port.to_string())
        .env("PGUSER", &profile.username)
        .env("PGDATABASE", &profile.dbname)
        .env("PGOPTIONS", "-c default_transaction_read_only=on")
        .env("PGCONNECT_TIMEOUT", "10")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    if let Some(pw) = &password {
        cmd.env("PGPASSWORD", pw);
    }
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("failed to launch claude CLI: {e}"))?;

    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(schema.as_bytes())
            .await
            .map_err(|e| format!("claude stdin: {e}"))?;
    }

    let out = tokio::time::timeout(
        std::time::Duration::from_secs(600),
        child.wait_with_output(),
    )
    .await
    .map_err(|_| "exploration timed out after 10 minutes".to_string())?
    .map_err(|e| format!("claude CLI: {e}"))?;

    eprintln!(
        "[ai] explore: status={} stdout={}B stderr={}B",
        out.status,
        out.stdout.len(),
        out.stderr.len()
    );
    if !out.status.success() {
        eprintln!(
            "[ai] explore stderr: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        );
        return Err(format!(
            "claude CLI failed ({}): {}",
            out.status,
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    let doc = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if doc.is_empty() {
        return Err("exploration returned no output".into());
    }
    // Persist as the profile's CLAUDE.md — future ai_generate_query calls run
    // with this directory as cwd and pick it up automatically.
    std::fs::write(dir.join("CLAUDE.md"), &doc).map_err(|e| format!("write context: {e}"))?;
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
}
