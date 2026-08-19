//! Configuration for the lb-proxy, loaded from environment variables.
//!
//! Everything here maps 1:1 onto router-core's `ScoreboardConfig` /
//! `SafetyThresholds` / staleness concepts. No business logic lives here.

use std::time::Duration;

use router_core::SafetyThresholds;

/// Runtime configuration for the proxy.
#[derive(Debug, Clone)]
pub struct Config {
    /// Upstream backend URLs, e.g. `http://localhost:3001`. Index `i` maps to
    /// `router_core::ServerId(i)`.
    pub backend_pool: Vec<String>,
    /// Address the proxy's HTTP listener binds to.
    pub listen_addr: String,
    /// Latency SLO used to derive the scoreboard risk signal from observed
    /// response-head latency (per-response feedback).
    pub latency_slo: Duration,
    /// Sliding window over which 5xx responses and request counts are sampled
    /// for the fast safety override and scoreboard error-rate input.
    pub five_xx_window: Duration,
    /// Interval at which the background loop pushes observed health into the
    /// router-core scoreboard ("slow loop").
    pub health_poll: Duration,
    /// Thresholds for router-core's fast safety overrides (backlog / 5xx /
    /// in-flight penalties).
    pub safety: SafetyThresholds,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            backend_pool: Vec::new(),
            listen_addr: "0.0.0.0:8080".to_string(),
            latency_slo: Duration::from_millis(1000),
            five_xx_window: Duration::from_secs(10),
            health_poll: Duration::from_millis(500),
            safety: SafetyThresholds::default(),
        }
    }
}

impl Config {
    /// Build a config from the environment.
    ///
    /// Required: `BACKEND_POOL` (comma-separated URLs).
    ///
    /// Optional:
    /// - `LISTEN_ADDR` (default `0.0.0.0:8080`)
    /// - `LATENCY_SLO_MS` (default `1000`)
    /// - `FIVE_XX_WINDOW_SECS` (default `10`)
    /// - `HEALTH_POLL_MS` (default `500`)
    /// - `MAX_BACKLOG` (default `100`)
    /// - `MAX_5XX_COUNT` (default `10`)
    /// - `MAX_IN_FLIGHT` (default `500`)
    pub fn from_env() -> Result<Self, String> {
        let pool_raw = std::env::var("BACKEND_POOL")
            .map_err(|_| "BACKEND_POOL is required (comma-separated upstream URLs)".to_string())?;

        let backends: Vec<String> = pool_raw
            .split(',')
            .map(|s| s.trim().trim_end_matches('/').to_string())
            .filter(|s| !s.is_empty())
            .collect();

        if backends.is_empty() {
            return Err("BACKEND_POOL must contain at least one URL".to_string());
        }
        for url in &backends {
            url.parse::<http::Uri>()
                .map_err(|e| format!("invalid upstream URL `{url}`: {e}"))?;
        }

        Ok(Self {
            backend_pool: backends,
            listen_addr: env_str("LISTEN_ADDR", "0.0.0.0:8080"),
            latency_slo: Duration::from_millis(env_u64("LATENCY_SLO_MS", 1000)),
            five_xx_window: Duration::from_secs(env_u64("FIVE_XX_WINDOW_SECS", 10)),
            health_poll: Duration::from_millis(env_u64("HEALTH_POLL_MS", 500)),
            safety: SafetyThresholds {
                max_backlog: env_u64("MAX_BACKLOG", 100),
                max_5xx_count: env_u64("MAX_5XX_COUNT", 10),
                max_in_flight: env_u64("MAX_IN_FLIGHT", 500),
            },
        })
    }

    /// Build a config for tests / programmatic use.
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn with_backends(backends: Vec<String>) -> Self {
        Self {
            backend_pool: backends,
            ..Default::default()
        }
    }
}

fn env_str(key: &str, default: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| default.to_string())
}

fn env_u64(key: &str, default: u64) -> u64 {
    std::env::var(key)
        .ok()
        .and_then(|v| v.trim().parse().ok())
        .unwrap_or(default)
}