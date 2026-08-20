//! lb-proxy — thin reverse proxy wrapping the router-core P2C load balancer.
//!
//! Zero policy of its own: no auth, no rate limiting, no request rewriting.
//! It just (1) asks `router_core::Router` which backend to use, (2) forwards the
//! request, (3) records real health signals (latency, 5xx, in-flight) back into
//! router-core's scoreboard so the next decision reflects backend health.
//!
//! The ML layer is intentionally absent — `router-core` ships without it and
//! this crate is not the place to re-introduce it (see repo CLAUDE.md).

mod config;
mod health;
mod proxy;
#[cfg(test)]
mod tests;

use config::Config;
use proxy::ProxyState;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let cfg = Config::from_env().unwrap_or_else(|e| {
        eprintln!("[lb-proxy] configuration error: {e}");
        std::process::exit(1);
    });

    let state = ProxyState::new(cfg.clone());

    println!("[lb-proxy] backends:");
    for (i, url) in cfg.backend_pool.iter().enumerate() {
        println!("[lb-proxy]   {i}: {url}");
    }
    println!(
        "[lb-proxy] listening on {} (latency SLO {}ms, 5xx window {}s)",
        cfg.listen_addr,
        cfg.latency_slo.as_millis(),
        cfg.five_xx_window.as_secs(),
    );

    let listener = tokio::net::TcpListener::bind(&cfg.listen_addr)
        .await
        .map_err(|e| format!("failed to bind {}: {e}", cfg.listen_addr))?;

    proxy::run_until(listener, state, shutdown_signal()).await;
    Ok(())
}

/// Resolves on Ctrl-C or SIGTERM (the signal Kubernetes sends a pod during
/// termination — rolling updates, scale-down, node drain — before waiting
/// `terminationGracePeriodSeconds` and then SIGKILLing it). Wired into
/// `proxy::run_until` so the proxy stops accepting new connections and
/// drains in-flight ones instead of dying mid-request.
async fn shutdown_signal() {
    let ctrl_c = async {
        if let Err(e) = tokio::signal::ctrl_c().await {
            eprintln!("[lb-proxy] failed to install Ctrl-C handler: {e}");
        }
    };

    #[cfg(unix)]
    let terminate = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut sig) => {
                sig.recv().await;
            }
            Err(e) => eprintln!("[lb-proxy] failed to install SIGTERM handler: {e}"),
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {}
        _ = terminate => {}
    }
}