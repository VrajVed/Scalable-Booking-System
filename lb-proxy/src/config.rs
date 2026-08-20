//! Configuration for the lb-proxy, loaded from environment variables.
//!
//! Everything here maps 1:1 onto router-core's `ScoreboardConfig` /
//! `SafetyThresholds` / staleness concepts. No business logic lives here.

use std::time::Duration;

use router_core::SafetyThresholds;

/// Which routing decision the proxy uses to pick a backend per request.
///
/// `RoundRobin` exists only to let the load-test harness compare P2C against
/// a plain round-robin baseline through the *same* proxy binary and network
/// path — isolating the algorithm instead of confounding it with a different
/// proxy implementation. It is not meant to be a supported production mode;
/// `P2c` (router-core, the real routing engine) is the default and what
/// every non-test deployment uses.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RoutingAlgorithm {
    P2c,
    RoundRobin,
}

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
    /// See `RoutingAlgorithm`. Defaults to `P2c`.
    pub algorithm: RoutingAlgorithm,
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
            algorithm: RoutingAlgorithm::P2c,
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
            let parsed = url
                .parse::<http::Uri>()
                .map_err(|e| format!("invalid upstream URL `{url}`: {e}"))?;
            // `http::Uri` accepts scheme-less strings like "localhost:3001"
            // as valid *relative* URIs (scheme = None). That's not usable
            // as an upstream target for hyper's HttpConnector, and letting
            // it through here just defers a startup typo into a permanent
            // per-request 502 against that backend. Require an explicit
            // scheme (and therefore an authority) up front instead.
            if parsed.scheme_str().is_none() || parsed.authority().is_none() {
                return Err(format!(
                    "invalid upstream URL `{url}`: missing scheme (expected e.g. `http://{url}`)"
                ));
            }
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
            algorithm: match env_str("ROUTING_ALGORITHM", "p2c").to_lowercase().as_str() {
                "round-robin" | "round_robin" | "roundrobin" => RoutingAlgorithm::RoundRobin,
                _ => RoutingAlgorithm::P2c,
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    /// `std::env` is process-global; serialize every test that touches it so
    /// they don't race each other under `cargo test`'s default parallelism.
    static ENV_LOCK: Mutex<()> = Mutex::new(());

    /// Set the given env vars, run `f`, then remove exactly those vars
    /// (regardless of pass/fail) so no test leaks state into another.
    fn with_env<R>(vars: &[(&str, &str)], f: impl FnOnce() -> R) -> R {
        let guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        for (k, v) in vars {
            std::env::set_var(k, v);
        }
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(f));
        for (k, _) in vars {
            std::env::remove_var(k);
        }
        drop(guard);
        result.unwrap_or_else(|e| std::panic::resume_unwind(e))
    }

    #[test]
    fn rejects_missing_backend_pool() {
        with_env(&[], || {
            std::env::remove_var("BACKEND_POOL");
            let err = Config::from_env().unwrap_err();
            assert!(err.contains("BACKEND_POOL"), "unexpected error: {err}");
        });
    }

    #[test]
    fn double_comma_is_tolerated_as_a_dropped_empty_entry() {
        // A stray double comma produces an empty split segment, which is
        // filtered out rather than becoming a bogus backend. This is
        // deliberately lenient (matches a trailing-comma-tolerant CSV
        // parser) rather than a hard error — documented here so a future
        // change to stricter parsing is a deliberate decision, not a
        // regression.
        with_env(&[("BACKEND_POOL", "http://a,,http://b")], || {
            let cfg = Config::from_env().unwrap();
            assert_eq!(cfg.backend_pool, vec!["http://a".to_string(), "http://b".to_string()]);
        });
    }

    #[test]
    fn trailing_comma_is_tolerated() {
        with_env(&[("BACKEND_POOL", "http://a,http://b,")], || {
            let cfg = Config::from_env().unwrap();
            assert_eq!(cfg.backend_pool, vec!["http://a".to_string(), "http://b".to_string()]);
        });
    }

    #[test]
    fn whitespace_only_entry_is_dropped_not_kept_as_blank_backend() {
        with_env(&[("BACKEND_POOL", "http://a,   ,http://b")], || {
            let cfg = Config::from_env().unwrap();
            assert_eq!(cfg.backend_pool, vec!["http://a".to_string(), "http://b".to_string()]);
        });
    }

    #[test]
    fn all_entries_empty_after_filtering_is_rejected() {
        with_env(&[("BACKEND_POOL", " , , ,")], || {
            let err = Config::from_env().unwrap_err();
            assert!(err.contains("at least one URL"), "unexpected error: {err}");
        });
    }

    /// BUG: a `BACKEND_POOL` entry with no `scheme://` (e.g. copy-pasted as
    /// `localhost:3001` instead of `http://localhost:3001`) is NOT rejected
    /// at startup. `http::Uri` happily parses `"localhost:3001"` as a valid
    /// *relative* URI (scheme = None, authority = Some("localhost:3001")),
    /// so the `url.parse::<http::Uri>()` validation in `from_env` passes.
    /// The failure only surfaces later, per-request, as a 502 from every
    /// call to that backend (hyper's `HttpConnector` needs an absolute
    /// URI with a scheme to know where to connect) — a misconfiguration
    /// that should fail loudly at startup instead silently degrades one
    /// backend in the pool to permanently-502.
    ///
    /// This test encodes the desired behavior (reject at config time) and
    /// currently fails against the actual code, which accepts it.
    #[test]
    fn rejects_backend_url_missing_scheme() {
        with_env(&[("BACKEND_POOL", "localhost:3001")], || {
            let result = Config::from_env();
            assert!(
                result.is_err(),
                "a scheme-less backend URL should be rejected at startup, not accepted as {result:?}"
            );
        });
    }

    #[test]
    fn rejects_single_malformed_url_even_with_other_valid_urls() {
        with_env(&[("BACKEND_POOL", "http://a,not a url with spaces")], || {
            let err = Config::from_env().unwrap_err();
            assert!(err.contains("invalid upstream URL"), "unexpected error: {err}");
        });
    }

    #[test]
    fn garbage_numeric_env_var_silently_falls_back_to_default() {
        // Characterizes CURRENT behavior: a typo'd numeric env var (e.g.
        // "LATENCY_SLO_MS=1000ms" instead of "1000") is silently swallowed
        // and the default is used, with no warning printed anywhere. This
        // masks misconfiguration rather than failing loudly. Left as a
        // passing characterization test (not a "should fail" test) because
        // unlike the missing-scheme case above, there's no existing
        // validation code whose contract is being violated — this is a
        // debatable design choice (lenient defaults vs. fail-fast) rather
        // than an unambiguous bug, so it's flagged in the report rather
        // than "fixed" by guessing at intended behavior.
        with_env(
            &[
                ("BACKEND_POOL", "http://a"),
                ("LATENCY_SLO_MS", "not-a-number"),
            ],
            || {
                let cfg = Config::from_env().unwrap();
                assert_eq!(
                    cfg.latency_slo,
                    Duration::from_millis(1000),
                    "garbage numeric input currently falls back to the default instead of failing"
                );
            },
        );
    }

    #[test]
    fn valid_numeric_overrides_are_applied() {
        with_env(
            &[
                ("BACKEND_POOL", "http://a"),
                ("LATENCY_SLO_MS", "250"),
                ("FIVE_XX_WINDOW_SECS", "3"),
                ("HEALTH_POLL_MS", "10"),
                ("MAX_BACKLOG", "7"),
                ("MAX_5XX_COUNT", "2"),
                ("MAX_IN_FLIGHT", "9"),
            ],
            || {
                let cfg = Config::from_env().unwrap();
                assert_eq!(cfg.latency_slo, Duration::from_millis(250));
                assert_eq!(cfg.five_xx_window, Duration::from_secs(3));
                assert_eq!(cfg.health_poll, Duration::from_millis(10));
                assert_eq!(cfg.safety.max_backlog, 7);
                assert_eq!(cfg.safety.max_5xx_count, 2);
                assert_eq!(cfg.safety.max_in_flight, 9);
            },
        );
    }

    #[test]
    fn trailing_slash_on_backend_url_is_stripped() {
        with_env(&[("BACKEND_POOL", "http://a/,http://b/")], || {
            let cfg = Config::from_env().unwrap();
            assert_eq!(cfg.backend_pool, vec!["http://a".to_string(), "http://b".to_string()]);
        });
    }
}