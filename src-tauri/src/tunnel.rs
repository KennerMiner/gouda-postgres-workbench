//! SSH tunneling for connections behind a bastion.
//!
//! Opens an SSH session (agent auth first, then key files), verifies the host
//! against ~/.ssh/known_hosts, binds an ephemeral local listener, and bridges
//! each accepted TCP connection to a direct-tcpip channel targeting the
//! database host as seen from the SSH server.
//!
//! A `Tunnel`'s lifetime is tied to the connection entry that uses it; drop
//! aborts the listener task, which owns the SSH session.

use std::sync::Arc;

use russh::client;
use russh::keys::{self, PrivateKeyWithHashAlg};
use tokio::net::TcpListener;

#[derive(Clone, Debug)]
pub struct SshParams {
    pub host: String,
    pub port: u16,
    pub user: String,
    /// Explicit key file; None = try SSH agent, then default key files.
    pub key_path: Option<String>,
}

pub struct Tunnel {
    pub local_port: u16,
    task: tokio::task::JoinHandle<()>,
}

impl Drop for Tunnel {
    fn drop(&mut self) {
        self.task.abort();
    }
}

struct HostCheck {
    host: String,
    port: u16,
}

impl client::Handler for HostCheck {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &keys::PublicKey,
    ) -> Result<bool, Self::Error> {
        match keys::check_known_hosts(&self.host, self.port, server_public_key) {
            Ok(true) => Ok(true),
            Ok(false) => Ok(false), // key changed — refuse
            Err(_) => Ok(false),    // unknown host — refuse (ssh once manually to trust)
        }
    }
}

fn home() -> String {
    std::env::var("HOME").unwrap_or_default()
}

async fn authenticate(
    handle: &mut client::Handle<HostCheck>,
    ssh: &SshParams,
) -> Result<(), String> {
    let mut attempts: Vec<String> = Vec::new();

    // 1) Explicit key file, if configured.
    if let Some(path) = &ssh.key_path {
        let key = keys::load_secret_key(path, None)
            .map_err(|e| format!("ssh key {path}: {e} (passphrase-protected keys need the agent)"))?;
        let alg = handle
            .best_supported_rsa_hash()
            .await
            .map_err(|e| format!("ssh: {e}"))?
            .flatten();
        let auth = handle
            .authenticate_publickey(
                ssh.user.clone(),
                PrivateKeyWithHashAlg::new(Arc::new(key), alg),
            )
            .await
            .map_err(|e| format!("ssh auth: {e}"))?;
        if auth.success() {
            return Ok(());
        }
        return Err(format!("ssh: key {path} rejected for user {}", ssh.user));
    }

    // 2) SSH agent identities (certificates skipped for now).
    if let Ok(mut agent) = keys::agent::client::AgentClient::connect_env().await {
        if let Ok(identities) = agent.request_identities().await {
            for identity in identities {
                let keys::agent::AgentIdentity::PublicKey { key, .. } = identity else {
                    continue;
                };
                let alg = handle
                    .best_supported_rsa_hash()
                    .await
                    .map_err(|e| format!("ssh: {e}"))?
                    .flatten();
                match handle
                    .authenticate_publickey_with(ssh.user.clone(), key, alg, &mut agent)
                    .await
                {
                    Ok(auth) if auth.success() => return Ok(()),
                    Ok(_) => attempts.push("agent identity rejected".into()),
                    Err(e) => attempts.push(format!("agent: {e}")),
                }
            }
        }
    } else {
        attempts.push("no ssh agent".into());
    }

    // 3) Default key files (passphrase-less only; encrypted keys need the agent).
    for name in ["id_ed25519", "id_rsa"] {
        let path = format!("{}/.ssh/{name}", home());
        if !std::path::Path::new(&path).exists() {
            continue;
        }
        match keys::load_secret_key(&path, None) {
            Ok(key) => {
                let alg = handle
                    .best_supported_rsa_hash()
                    .await
                    .map_err(|e| format!("ssh: {e}"))?
                    .flatten();
                let auth = handle
                    .authenticate_publickey(
                        ssh.user.clone(),
                        PrivateKeyWithHashAlg::new(Arc::new(key), alg),
                    )
                    .await
                    .map_err(|e| format!("ssh auth: {e}"))?;
                if auth.success() {
                    return Ok(());
                }
                attempts.push(format!("{name} rejected"));
            }
            Err(e) => attempts.push(format!("{name}: {e}")),
        }
    }

    Err(format!(
        "ssh: no accepted auth for {}@{} ({})",
        ssh.user,
        ssh.host,
        attempts.join("; ")
    ))
}

/// Open a tunnel: local ephemeral port -> ssh server -> target_host:target_port.
pub async fn open(ssh: SshParams, target_host: String, target_port: u16) -> Result<Tunnel, String> {
    let config = Arc::new(client::Config {
        keepalive_interval: Some(std::time::Duration::from_secs(30)),
        ..Default::default()
    });

    let checker = HostCheck {
        host: ssh.host.clone(),
        port: ssh.port,
    };
    let mut handle = tokio::time::timeout(
        std::time::Duration::from_secs(10),
        client::connect(config, (ssh.host.as_str(), ssh.port), checker),
    )
    .await
    .map_err(|_| format!("ssh: timeout connecting to {}:{}", ssh.host, ssh.port))?
    .map_err(|e| match e {
        russh::Error::UnknownKey => format!(
            "ssh: host key for {} not trusted — run `ssh {}@{}` once to add it to known_hosts",
            ssh.host, ssh.user, ssh.host
        ),
        e => format!("ssh connect: {e}"),
    })?;

    authenticate(&mut handle, &ssh).await?;

    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .map_err(|e| format!("tunnel listen: {e}"))?;
    let local_port = listener
        .local_addr()
        .map_err(|e| format!("tunnel: {e}"))?
        .port();

    // The listener task owns the session handle; aborting it (via Drop) closes
    // the session, which in turn ends any in-flight bridge tasks.
    let task = tokio::spawn(async move {
        loop {
            let Ok((mut tcp, peer)) = listener.accept().await else {
                break;
            };
            let channel = match handle
                .channel_open_direct_tcpip(
                    target_host.clone(),
                    target_port as u32,
                    peer.ip().to_string(),
                    peer.port() as u32,
                )
                .await
            {
                Ok(c) => c,
                Err(e) => {
                    eprintln!("tunnel channel failed: {e}");
                    continue;
                }
            };
            tokio::spawn(async move {
                let mut stream = channel.into_stream();
                let _ = tokio::io::copy_bidirectional(&mut tcp, &mut stream).await;
            });
        }
    });

    Ok(Tunnel { local_port, task })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// End-to-end: tunnel to the dev bastion, then run a query on a Postgres
    /// that only listens on the bastion's localhost. Requires `ssh dev` to
    /// work non-interactively; run explicitly:
    ///   cargo test tunnel_end_to_end -- --ignored --nocapture
    #[tokio::test]
    #[ignore]
    async fn tunnel_end_to_end() {
        let host =
            std::env::var("PSQLV_SSH_HOST").expect("set PSQLV_SSH_HOST to the bastion hostname");
        let user = std::env::var("PSQLV_SSH_USER").unwrap_or_else(|_| "admin".into());

        let tunnel = open(
            SshParams {
                host,
                port: 22,
                user,
                key_path: std::env::var("PSQLV_SSH_KEY").ok(),
            },
            "127.0.0.1".into(),
            5432,
        )
        .await
        .expect("tunnel open");

        let mut config = tokio_postgres::Config::new();
        config
            .host("127.0.0.1")
            .port(tunnel.local_port)
            .dbname("tunneltest")
            .user("tunneltest")
            .password("tunneltest")
            .connect_timeout(std::time::Duration::from_secs(10));
        let (client, connection) = config.connect(tokio_postgres::NoTls).await.expect("pg connect");
        tokio::spawn(connection);

        let row = client
            .query_one("select current_setting('server_version'), 40 + 2", &[])
            .await
            .expect("query");
        let version: String = row.get(0);
        let sum: i32 = row.get(1);
        assert_eq!(sum, 42);
        println!("tunneled to PostgreSQL {version}");
    }
}
