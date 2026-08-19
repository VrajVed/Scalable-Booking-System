// =============================================================================
// router.rs — Per-request routing engine (Power of Two Choices + ML weights)
// =============================================================================
//
// Performance contract:
//   choose_server() must complete in < 1 µs.
//   Therefore:
//     • NO heap allocations on the hot path.
//     • NO blocking operations.
//     • NO ML inference.
//     • Only a wait-free scoreboard lookup (ArcSwap::load).
//
// Algorithm (P2C with predictive weighting):
//   1.  Pick two candidate servers uniformly at random.
//   2.  Load their weights from the scoreboard (wait-free).
//   3.  Apply fast safety overrides (backlog / 5xx / in-flight).
//   4.  Choose the candidate with the higher effective weight.
//   5.  If both scores are stale, fall back to random uniform selection.
//
// Why P2C instead of weighted-random?
//   P2C is proven to give O(log log N) max-load with two random probes,
//   and it avoids the "join-the-shortest-queue" problem where all routers
//   simultaneously pile onto one low-latency server.  Adding ML weights
//   biases the choice without creating a total ordering that could herd.
//
// Fast safety overrides:
//   The ML model runs on a slow loop (100–500 ms).  Within that window,
//   microbursts can occur (sudden queue spikes, 5xx storms).  The router
//   maintains lightweight per-server counters updated on the request path
//   and uses them to override ML weights when immediate danger is detected.
//   This is a classic *inner-loop override* pattern from control theory.
// =============================================================================

use std::collections::HashMap;
use std::time::Instant;

use crate::scoreboard::Scoreboard;
use crate::types::*;

/// The routing engine.
///
/// Holds a reference to the shared scoreboard and the list of live servers.
/// All mutable state is either atomic or thread-local.
pub struct Router {
    /// Reference to the lock-free scoreboard (shared with the inference engine).
    scoreboard: Scoreboard,

    /// The set of all registered backend servers.
    /// Stored as a Vec for O(1) random-index access during P2C selection.
    servers: Vec<ServerId>,

    /// Thresholds for the fast safety override system.
    safety: SafetyThresholds,

    /// Thread-local PRNG state.  We use a simple xorshift64 to avoid
    /// pulling in a full RNG crate on the hot path.  Seeded from the
    /// system clock at construction time.
    rng_state: std::cell::Cell<u64>,
}

impl Router {
    // -----------------------------------------------------------------
    // Construction
    // -----------------------------------------------------------------

    pub fn new(scoreboard: Scoreboard, servers: Vec<ServerId>, safety: SafetyThresholds) -> Self {
        // Seed PRNG from system time to get reasonable entropy without
        // depending on getrandom (which can block).
        let seed = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos() as u64;

        Self {
            scoreboard,
            servers,
            safety,
            rng_state: std::cell::Cell::new(seed | 1), // ensure non-zero
        }
    }

    // -----------------------------------------------------------------
    // Hot path
    // -----------------------------------------------------------------

    /// Choose a backend server for the incoming request.
    ///
    /// `fast_signals`: per-server health signals collected locally.
    ///
    /// Returns `None` only if there are zero registered servers.
    ///
    /// # Performance
    ///
    /// This function performs:
    ///   - 1 ArcSwap load (wait-free)
    ///   - 2 HashMap lookups (O(1) amortized)
    ///   - 2 fast_signals lookups (O(1) amortized)
    ///   - 1 xorshift64 call
    ///   - A handful of floating-point comparisons
    ///
    /// Total: well under 1 µs on modern hardware.
    #[inline]
    pub fn choose_server(
        &self,
        fast_signals: &HashMap<ServerId, FastHealthSignals>,
    ) -> Option<ServerId> {
        let n = self.servers.len();
        if n == 0 {
            return None;
        }
        if n == 1 {
            return Some(self.servers[0]);
        }

        // ---- Pick two distinct random candidates ----
        let i = self.fast_random_index(n);
        let mut j = self.fast_random_index(n);
        // Ensure j ≠ i.  In the rare collision case just advance by 1.
        if j == i {
            j = (j + 1) % n;
        }
        let a = self.servers[i];
        let b = self.servers[j];

        // ---- Load scoreboard snapshot (wait-free) ----
        let snap = self.scoreboard.load();
        let now = Instant::now();
        let ttl = self.scoreboard.staleness_ttl();

        let score_a = snap.get(&a);
        let score_b = snap.get(&b);

        // ---- Compute effective weights ----
        let ew_a = self.effective_weight(score_a, &a, fast_signals, now, ttl);
        let ew_b = self.effective_weight(score_b, &b, fast_signals, now, ttl);

        // ---- Choose the better candidate ----
        if ew_a >= ew_b {
            Some(a)
        } else {
            Some(b)
        }
    }

    /// Compute the effective weight for a candidate server.
    ///
    /// This combines the ML-predicted weight with fast safety overrides.
    ///
    /// If the score is stale or missing, we fall back to a neutral weight (1.0)
    /// so the server participates in round-robin but doesn't get preferential
    /// treatment.
    #[inline]
    fn effective_weight(
        &self,
        score: Option<&ServerScore>,
        server: &ServerId,
        fast_signals: &HashMap<ServerId, FastHealthSignals>,
        now: Instant,
        ttl: std::time::Duration,
    ) -> f64 {
        // Base weight from the scoreboard.
        let base = match score {
            Some(s) if now.duration_since(s.updated_at) < ttl => s.weight,
            _ => {
                // Score is stale or missing — fall back to uniform.
                // This prevents ML model failures from breaking routing.
                1.0 / self.servers.len() as f64
            }
        };

        // ---- Fast safety override ----
        // If local health signals indicate immediate danger, heavily
        // penalize this server regardless of the ML prediction.
        //
        // We use a multiplicative penalty so that:
        //   - A server with one signal slightly over threshold gets a
        //     moderate penalty (0.1×).
        //   - A server with multiple signals over threshold gets
        //     compounded penalties.
        //
        // This is cheaper than an additive model and naturally bounds
        // the output to [0, base].
        let mut penalty = 1.0_f64;

        if let Some(sig) = fast_signals.get(server) {
            if sig.backlog > self.safety.max_backlog {
                penalty *= 0.1;
            }
            if sig.error_5xx_count > self.safety.max_5xx_count {
                penalty *= 0.1;
            }
            if sig.in_flight > self.safety.max_in_flight {
                penalty *= 0.1;
            }
        }

        base * penalty
    }

    // -----------------------------------------------------------------
    // PRNG (xorshift64 — fast, no alloc, deterministic per thread)
    // -----------------------------------------------------------------

    /// Return a random index in [0, n).  Uses xorshift64.
    #[inline]
    fn fast_random_index(&self, n: usize) -> usize {
        let mut s = self.rng_state.get();
        s ^= s << 13;
        s ^= s >> 7;
        s ^= s << 17;
        self.rng_state.set(s);
        (s as usize) % n
    }

    // -----------------------------------------------------------------
    // Accessors
    // -----------------------------------------------------------------

    /// Return a reference to the underlying scoreboard (for the inference
    /// engine to push updates).
    pub fn scoreboard(&self) -> &Scoreboard {
        &self.scoreboard
    }

    /// Return the current server list.
    pub fn servers(&self) -> &[ServerId] {
        &self.servers
    }

    /// Dynamically add a server to the pool.
    pub fn add_server(&mut self, server: ServerId) {
        if !self.servers.contains(&server) {
            self.servers.push(server);
        }
    }

    /// Remove a server from the pool.
    pub fn remove_server(&mut self, server: &ServerId) {
        self.servers.retain(|s| s != server);
    }
}

// =============================================================================
// Tests
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    fn setup_router(n: u64) -> Router {
        let servers: Vec<(ServerId, DomainId)> =
            (0..n).map(|i| (ServerId(i), DomainId(i % 2))).collect();
        let server_ids: Vec<ServerId> = servers.iter().map(|&(s, _)| s).collect();
        let sb = Scoreboard::with_servers(&servers, ScoreboardConfig::default());
        Router::new(sb, server_ids, SafetyThresholds::default())
    }

    #[test]
    fn test_choose_server_returns_some() {
        let router = setup_router(5);
        let signals = HashMap::new();
        let choice = router.choose_server(&signals);
        assert!(choice.is_some());
    }

    #[test]
    fn test_choose_server_empty_pool() {
        let sb = Scoreboard::new(ScoreboardConfig::default());
        let router = Router::new(sb, vec![], SafetyThresholds::default());
        let signals = HashMap::new();
        assert!(router.choose_server(&signals).is_none());
    }

    #[test]
    fn test_choose_server_single_server() {
        let servers = vec![(ServerId(0), DomainId(0))];
        let sb = Scoreboard::with_servers(&servers, ScoreboardConfig::default());
        let router = Router::new(sb, vec![ServerId(0)], SafetyThresholds::default());
        let signals = HashMap::new();
        assert_eq!(router.choose_server(&signals), Some(ServerId(0)));
    }

    #[test]
    fn test_safety_override_penalizes_unhealthy_server() {
        let router = setup_router(2);

        // Make server 0 very unhealthy.
        let mut signals = HashMap::new();
        signals.insert(ServerId(0), FastHealthSignals {
            backlog: 999,
            error_5xx_count: 999,
            in_flight: 9999,
        });

        // Run many iterations — nearly all should avoid server 0.
        let mut counts = [0u64; 2];
        for _ in 0..10_000 {
            if let Some(sid) = router.choose_server(&signals) {
                counts[sid.0 as usize] += 1;
            }
        }

        // Server 1 should receive the vast majority of traffic.
        assert!(
            counts[1] > counts[0] * 5,
            "unhealthy server should be avoided: s0={}, s1={}",
            counts[0],
            counts[1],
        );
    }

    #[test]
    fn test_distribution_biased_by_risk() {
        let servers: Vec<(ServerId, DomainId)> =
            (0..2).map(|i| (ServerId(i), DomainId(0))).collect();
        let server_ids: Vec<ServerId> = servers.iter().map(|&(s, _)| s).collect();
        let sb = Scoreboard::with_servers(&servers, ScoreboardConfig {
            smoothing_alpha: 1.0,
            max_shift_fraction: 1.0,
            domain_capacity_fraction: 1.0,
            max_alpha: 1.0, // match smoothing_alpha to disable adaptive clamping
            ..Default::default()
        });

        // Server 0 is risky, server 1 is safe.
        let mut preds = HashMap::new();
        preds.insert(ServerId(0), ServerPrediction::from_risk_confidence(0.9, 1.0));
        preds.insert(ServerId(1), ServerPrediction::from_risk_confidence(0.1, 1.0));
        // Push several rounds so the weights converge.
        for _ in 0..20 {
            sb.update_scores(&preds, 0.0);
        }

        let router = Router::new(sb, server_ids, SafetyThresholds::default());
        let signals = HashMap::new();

        let mut counts = [0u64; 2];
        for _ in 0..50_000 {
            if let Some(sid) = router.choose_server(&signals) {
                counts[sid.0 as usize] += 1;
            }
        }

        // Server 1 (low risk) should get more traffic.
        assert!(
            counts[1] > counts[0],
            "low-risk server should get more traffic: s0={}, s1={}",
            counts[0],
            counts[1],
        );
    }

    #[test]
    fn test_add_remove_server() {
        let mut router = setup_router(3);
        assert_eq!(router.servers().len(), 3);

        router.add_server(ServerId(99));
        assert_eq!(router.servers().len(), 4);

        router.remove_server(&ServerId(1));
        assert_eq!(router.servers().len(), 3);
        assert!(!router.servers().contains(&ServerId(1)));
    }
}
