//! "Ask AI" query generation, provider: the `claude` CLI (uses the user's
//! existing Claude Code login — no API key to manage). The provider seam is
//! this one command; an Anthropic-API backend can slot in later.

use tokio::io::AsyncWriteExt;
use tokio::process::Command;

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
pub async fn ai_generate_query(prompt: String, context: String) -> Result<String, String> {
    let instruction = format!(
        "Using the PostgreSQL schema and sample data provided on stdin, write a single \
         PostgreSQL query for this request: {prompt}\n\
         Respond with ONLY SQL — no markdown fences, no prose outside SQL comments. \
         Start with a short block of '--' comments explaining the approach, then the query \
         itself with brief inline '--' comments on non-obvious parts. \
         Use only tables and columns that exist in the provided schema."
    );

    // zsh -lc: GUI apps get a minimal PATH; a login shell finds `claude`.
    // The instruction travels in an env var to avoid shell-quoting hazards.
    let mut child = Command::new("/bin/zsh")
        .arg("-lc")
        .arg(r#"claude -p "$PSQLV_INSTRUCTION""#)
        .env("PSQLV_INSTRUCTION", &instruction)
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

    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
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
