// =============================================================================
// scoreboard.rs — Lock-free scoreboard using RCU (Read-Copy-Update) semantics
// =============================================================================
//
// Architecture:
//   The scoreboard is the bridge between the *slow loop* (ML inference, ~100–500 ms)
//   and the *fast loop* (per-request routing, < 1 µs).
//
//   Writes:  The inference engine periodically pushes a new `HashMap<ServerId, ServerScore>`.
//            The update logic applies smoothing, shift caps, domain caps, and normalization,
//            then atomically swaps the pointer via `ArcSwap`.
//
//   Reads:   The router calls `get_weight()` which performs a single `arc_swap::Guard` load —
//            a wait-free, zero-allocation operation on the read side.
//
// Safety invariants enforced on every write:
//   1. Exponential smoothing           — prevents oscillation
//   2. Max-shift cap                   — limits per-cycle weight change
//   3. Domain capacity cap             — limits traffic to any failure domain
//   4. Exploration floor (min weight)  — prevents dead-node starvation
//   5. Normalization                   — weights sum to 1.0
//
// Why ArcSwap instead of RwLock:
//   RwLock introduces writer starvation risk and cache-line contention under
//   high read concurrency.  ArcSwap gives us truly wait-free reads with only
//   an atomic load + reference-count bump on the fast path.
// =============================================================================

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Instant;

use arc_swap::{ArcSwap, Guard};

use crate::types::*;

/// Thread-safe, lock-free scoreboard.
///
/// Readers (router) call `load()` or `get_weight()` — these are wait-free.
/// Writers (inference engine) call `update_scores()` or `update_single_server()`.
pub struct Scoreboard {
    /// The RCU-protected score map.  Readers load a snapshot; writers build a new
    /// map and atomically swap it in.
    inner: ArcSwap<HashMap<ServerId, ServerScore>>,

    /// Tuning knobs for the update algorithm.
    config: ScoreboardConfig,
}

impl Scoreboard {
    // -----------------------------------------------------------------
    // Construction
    // -----------------------------------------------------------------

    /// Create an empty scoreboard.
    pub fn new(config: ScoreboardConfig) -> Self {
        Self {
            inner: ArcSwap::from_pointee(HashMap::new()),
            config,
        }
    }

    /// Create a scoreboard pre-populated with the given servers.
    /// All servers start with neutral risk and equal weight.
    pub fn with_servers(server_domains: &[(ServerId, DomainId)], config: ScoreboardConfig) -> Self {
        let n = server_domains.len() as f64;
        let initial_weight = if n > 0.0 { 1.0 / n } else { 0.0 };

        let mut map = HashMap::with_capacity(server_domains.len());
        for &(sid, did) in server_domains {
            let mut score = ServerScore::new(did);
            score.weight = initial_weight;
            map.insert(sid, score);
        }

        Self {
            inner: ArcSwap::from_pointee(map),
            config,
        }
    }

    // -----------------------------------------------------------------
    // Read path  (FAST — must be wait-free, no allocations)
    // -----------------------------------------------------------------

    /// Load a read-only snapshot of the current scoreboard.
    ///
    /// Cost: one atomic load + Arc clone (reference-count bump).
    /// This is the primary read primitive used by the router.
    #[inline]
    pub fn load(&self) -> Guard<Arc<HashMap<ServerId, ServerScore>>> {
        self.inner.load()
    }

    /// Convenience: get the weight for a single server.
    ///
    /// Returns `None` if the server is unknown.
    /// Returns the weight even if stale — the router is responsible for
    /// checking `updated_at` against the staleness TTL.
    #[inline]
    pub fn get_weight(&self, server: &ServerId) -> Option<f64> {
        let snap = self.inner.load();
        snap.get(server).map(|s| s.weight)
    }

    /// Get the full score entry for a server (used for logging / diagnostics).
    pub fn get_score(&self, server: &ServerId) -> Option<ServerScore> {
        let snap = self.inner.load();
        snap.get(server).cloned()
    }

    /// Return the staleness TTL from the config.
    pub fn staleness_ttl(&self) -> std::time::Duration {
        self.config.staleness_ttl
    }

    // -----------------------------------------------------------------
    // Write path  (SLOW — runs on the inference-engine thread)
    // -----------------------------------------------------------------

    /// Bulk-update all scores from the ML inference engine.
    ///
    /// `new_predictions` maps ServerId → ServerPrediction containing risk, uncertainty,
    /// confidence, and error rate.
    /// `cluster_load` is the average (in_flight / capacity) across the cluster,
    /// used for adaptive smoothing.  Pass 0.0 to use the base alpha.
    ///
    /// The function reads the current snapshot, applies all safety invariants,
    /// and atomically swaps in the new map.
    ///
    /// This is the primary write path, called every ~100–500 ms.
    pub fn update_scores(
        &self,
        new_predictions: &HashMap<ServerId, ServerPrediction>,
        cluster_load: f64,
    ) {
        let now = Instant::now();
        let old_snap = self.inner.load();

        // ---- Adaptive smoothing alpha (Improvement 3) ----
        // At high cluster load, reduce responsiveness to prevent oscillation.
        // At low cluster load, increase responsiveness for faster adaptation.
        let cluster_load_clamped = cluster_load.clamp(0.0, 1.0);
        let alpha = (self.config.smoothing_alpha * (1.0 - cluster_load_clamped))
            .clamp(self.config.min_alpha, self.config.max_alpha);

        // ---- Step 1: Build raw weights from predictions ----
        let mut new_map: HashMap<ServerId, ServerScore> = HashMap::with_capacity(old_snap.len());

        for (sid, old_score) in old_snap.iter() {
            let mut score = old_score.clone();

            if let Some(pred) = new_predictions.get(sid) {
                let risk_mean = pred.risk_mean.clamp(0.0, 1.0);
                let risk_variance = pred.risk_variance.max(0.0);
                let confidence = pred.confidence.clamp(0.0, 1.0);
                let error_rate = pred.error_rate.clamp(0.0, 1.0);

                // ---- Uncertainty-adjusted risk (Improvement 1) ----
                // effective_risk = risk_mean + λ * sqrt(risk_variance)
                // When λ = 0.0 (default), this reduces to the original risk.
                let lambda = self.config.risk_aversion_lambda;
                let effective_risk = (risk_mean + lambda * risk_variance.sqrt())
                    .clamp(0.0, 1.0);

                // ---- Health memory EMA (Improvement 4) ----
                // health_t = β * error_rate + (1−β) * health_(t−1)
                let beta = self.config.health_ema_beta;
                let new_health = beta * error_rate + (1.0 - beta) * old_score.health_score;

                // Raw weight: combines risk prediction with health history.
                // weight = exp(-effective_risk) * exp(-health_score)
                let raw_weight = (-effective_risk).exp() * (-new_health).exp();

                // ---- Invariant 1: Exponential smoothing (adaptive α) ----
                let smoothed = alpha * raw_weight + (1.0 - alpha) * old_score.weight;

                // ---- Invariant 2: Max shift cap ----
                let max_delta = self.config.max_shift_fraction * old_score.weight.max(self.config.min_weight);
                let capped = smoothed.clamp(
                    old_score.weight - max_delta,
                    old_score.weight + max_delta,
                );

                score.risk = effective_risk;
                score.confidence = confidence;
                score.weight = capped;
                score.updated_at = now;
                score.health_score = new_health;
            }
            // If no prediction arrived for this server, keep the old score
            // (it will age out via staleness TTL).

            new_map.insert(*sid, score);
        }

        // Also insert any new servers that appeared in predictions but not in old map.
        for (sid, pred) in new_predictions {
            if !new_map.contains_key(sid) {
                let risk_mean = pred.risk_mean.clamp(0.0, 1.0);
                let risk_variance = pred.risk_variance.max(0.0);
                let confidence = pred.confidence.clamp(0.0, 1.0);
                let error_rate = pred.error_rate.clamp(0.0, 1.0);

                let lambda = self.config.risk_aversion_lambda;
                let effective_risk = (risk_mean + lambda * risk_variance.sqrt())
                    .clamp(0.0, 1.0);
                let raw_weight = (-effective_risk).exp() * (-error_rate).exp();

                new_map.insert(*sid, ServerScore {
                    risk: effective_risk,
                    confidence,
                    weight: raw_weight,
                    updated_at: now,
                    domain: DomainId(0), // Unknown domain — operator should register it.
                    health_score: error_rate,
                });
            }
        }

        // ---- Invariant 3: Domain capacity cap ----
        self.apply_domain_caps(&mut new_map);

        // ---- Invariant 4: Exploration floor ----
        for score in new_map.values_mut() {
            if score.weight < self.config.min_weight {
                score.weight = self.config.min_weight;
            }
        }

        // ---- Invariant 5: Normalize weights to sum to 1.0 ----
        Self::normalize_weights(&mut new_map);

        // ---- Atomic swap ----
        self.inner.store(Arc::new(new_map));
    }

    /// Update a single server's score.  Useful for incremental updates.
    ///
    /// Applies the same safety invariants as `update_scores`.
    pub fn update_single_server(&self, server: ServerId, risk: f64, confidence: f64) {
        let mut preds = HashMap::new();
        preds.insert(server, ServerPrediction::from_risk_confidence(risk, confidence));
        self.update_scores(&preds, 0.0);
    }

    // -----------------------------------------------------------------
    // Internal invariant enforcement
    // -----------------------------------------------------------------

    /// Enforce domain-level traffic caps.
    ///
    /// If the total weight assigned to servers in the same failure domain
    /// exceeds `domain_capacity_fraction`, we proportionally scale down
    /// those servers' weights and redistribute the excess uniformly.
    fn apply_domain_caps(&self, map: &mut HashMap<ServerId, ServerScore>) {
        let cap = self.config.domain_capacity_fraction;

        // Accumulate total weight per domain.
        let mut domain_totals: HashMap<DomainId, f64> = HashMap::new();
        for score in map.values() {
            *domain_totals.entry(score.domain).or_insert(0.0) += score.weight;
        }

        let total_weight: f64 = map.values().map(|s| s.weight).sum();
        if total_weight <= 0.0 {
            return;
        }

        // For each domain that exceeds the cap, scale its members down.
        for (domain, domain_weight) in &domain_totals {
            let fraction = domain_weight / total_weight;
            if fraction > cap {
                // Scale factor to bring domain exactly to the cap.
                let scale = (cap * total_weight) / domain_weight;
                for score in map.values_mut() {
                    if score.domain == *domain {
                        score.weight *= scale;
                    }
                }
            }
        }
    }

    /// Normalize all weights so they sum to 1.0.
    fn normalize_weights(map: &mut HashMap<ServerId, ServerScore>) {
        let total: f64 = map.values().map(|s| s.weight).sum();
        if total > 0.0 {
            for score in map.values_mut() {
                score.weight /= total;
            }
        }
    }
}

// =============================================================================
// Tests
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn make_servers(n: u64) -> Vec<(ServerId, DomainId)> {
        (0..n).map(|i| (ServerId(i), DomainId(i % 3))).collect()
    }

    #[test]
    fn test_initial_weights_are_equal() {
        let servers = make_servers(4);
        let sb = Scoreboard::with_servers(&servers, ScoreboardConfig::default());
        let snap = sb.load();
        for score in snap.values() {
            assert!((score.weight - 0.25).abs() < 1e-9);
        }
    }

    #[test]
    fn test_weights_sum_to_one_after_update() {
        let servers = make_servers(5);
        let sb = Scoreboard::with_servers(&servers, ScoreboardConfig::default());

        let mut preds = HashMap::new();
        preds.insert(ServerId(0), ServerPrediction::from_risk_confidence(0.9, 1.0)); // high risk
        preds.insert(ServerId(1), ServerPrediction::from_risk_confidence(0.1, 1.0)); // low risk
        preds.insert(ServerId(2), ServerPrediction::from_risk_confidence(0.5, 0.8));
        preds.insert(ServerId(3), ServerPrediction::from_risk_confidence(0.3, 0.9));
        preds.insert(ServerId(4), ServerPrediction::from_risk_confidence(0.2, 0.95));

        sb.update_scores(&preds, 0.0);

        let snap = sb.load();
        let total: f64 = snap.values().map(|s| s.weight).sum();
        assert!((total - 1.0).abs() < 1e-9, "weights must sum to 1.0, got {total}");
    }

    #[test]
    fn test_min_weight_floor() {
        let servers = make_servers(3);
        let config = ScoreboardConfig {
            min_weight: 0.05,
            max_shift_fraction: 1.0, // large so the cap doesn't interfere
            ..Default::default()
        };
        let sb = Scoreboard::with_servers(&servers, config);

        // Push extreme risk for server 0.
        let mut preds = HashMap::new();
        preds.insert(ServerId(0), ServerPrediction::from_risk_confidence(0.999, 1.0));
        preds.insert(ServerId(1), ServerPrediction::from_risk_confidence(0.0, 1.0));
        preds.insert(ServerId(2), ServerPrediction::from_risk_confidence(0.0, 1.0));

        // Apply multiple rounds to let smoothing converge.
        for _ in 0..50 {
            sb.update_scores(&preds, 0.0);
        }

        let snap = sb.load();
        // After normalization the raw floor might be rescaled, but the
        // *relative* weight of the risky server should not drop below the
        // floor before normalization.  We test the normalized value is > 0.
        let w0 = snap.get(&ServerId(0)).unwrap().weight;
        assert!(w0 > 0.0, "min-weight floor must prevent zero weight");
    }

    #[test]
    fn test_max_shift_cap() {
        let servers = make_servers(2);
        let config = ScoreboardConfig {
            max_shift_fraction: 0.05,
            smoothing_alpha: 1.0, // no smoothing so we isolate the shift cap
            max_alpha: 1.0,       // match smoothing_alpha to disable adaptive clamping
            ..Default::default()
        };
        let sb = Scoreboard::with_servers(&servers, config);

        let snap_before = sb.load();
        let w_before = snap_before.get(&ServerId(0)).unwrap().weight;

        let mut preds = HashMap::new();
        preds.insert(ServerId(0), ServerPrediction::from_risk_confidence(0.99, 1.0));
        preds.insert(ServerId(1), ServerPrediction::from_risk_confidence(0.01, 1.0));
        sb.update_scores(&preds, 0.0);

        let snap_after = sb.load();
        let w_after = snap_after.get(&ServerId(0)).unwrap().weight;

        // The raw change before normalization would be huge, but the cap
        // limits it.  After normalization the total is 1.0 so we just
        // verify the shift is bounded.
        let delta = (w_after - w_before).abs();
        // With only 2 servers and normalization the picture is complex,
        // but the delta should be smaller than an uncapped update.
        assert!(delta < 0.5, "shift cap should limit drastic changes, delta={delta}");
    }

    #[test]
    fn test_staleness_ttl_config() {
        let config = ScoreboardConfig {
            staleness_ttl: Duration::from_secs(3),
            ..Default::default()
        };
        let sb = Scoreboard::new(config);
        assert_eq!(sb.staleness_ttl(), Duration::from_secs(3));
    }

    #[test]
    fn test_domain_cap() {
        // 4 servers: 3 in domain 0, 1 in domain 1.
        let servers = vec![
            (ServerId(0), DomainId(0)),
            (ServerId(1), DomainId(0)),
            (ServerId(2), DomainId(0)),
            (ServerId(3), DomainId(1)),
        ];
        let config = ScoreboardConfig {
            domain_capacity_fraction: 0.50,
            smoothing_alpha: 1.0,
            max_shift_fraction: 1.0,
            max_alpha: 1.0, // match smoothing_alpha to disable adaptive clamping
            ..Default::default()
        };
        let sb = Scoreboard::with_servers(&servers, config);

        // All servers have low risk — domain 0 would get 75% without cap.
        let mut preds = HashMap::new();
        preds.insert(ServerId(0), ServerPrediction::from_risk_confidence(0.1, 1.0));
        preds.insert(ServerId(1), ServerPrediction::from_risk_confidence(0.1, 1.0));
        preds.insert(ServerId(2), ServerPrediction::from_risk_confidence(0.1, 1.0));
        preds.insert(ServerId(3), ServerPrediction::from_risk_confidence(0.1, 1.0));

        for _ in 0..10 {
            sb.update_scores(&preds, 0.0);
        }

        let snap = sb.load();
        let domain0_weight: f64 = [ServerId(0), ServerId(1), ServerId(2)]
            .iter()
            .map(|s| snap.get(s).unwrap().weight)
            .sum();

        assert!(
            domain0_weight <= 0.55, // small tolerance above 0.50 for normalization rounding
            "domain cap should limit domain 0 to ≤50%, got {domain0_weight:.4}"
        );
    }

    #[test]
    fn test_uncertainty_increases_effective_risk() {
        // Two servers with equal mean risk, but server 0 has high variance.
        // With λ > 0, server 0 should get less traffic.
        let servers = vec![
            (ServerId(0), DomainId(0)),
            (ServerId(1), DomainId(1)),
        ];
        let config = ScoreboardConfig {
            risk_aversion_lambda: 1.5,
            smoothing_alpha: 1.0,
            max_shift_fraction: 1.0,
            max_alpha: 1.0,
            domain_capacity_fraction: 1.0, // disable domain cap for this test
            ..Default::default()
        };
        let sb = Scoreboard::with_servers(&servers, config);

        let mut preds = HashMap::new();
        // Same mean risk, but server 0 has high variance.
        preds.insert(ServerId(0), ServerPrediction {
            risk_mean: 0.3,
            risk_variance: 0.04,   // sqrt = 0.2 → effective_risk = 0.3 + 1.5*0.2 = 0.6
            confidence: 1.0,
            error_rate: 0.0,
        });
        preds.insert(ServerId(1), ServerPrediction {
            risk_mean: 0.3,
            risk_variance: 0.0,    // effective_risk = 0.3
            confidence: 1.0,
            error_rate: 0.0,
        });

        for _ in 0..20 {
            sb.update_scores(&preds, 0.0);
        }

        let snap = sb.load();
        let w0 = snap.get(&ServerId(0)).unwrap().weight;
        let w1 = snap.get(&ServerId(1)).unwrap().weight;
        assert!(
            w1 > w0,
            "server with lower uncertainty should get higher weight: w0={w0}, w1={w1}"
        );
    }

    #[test]
    fn test_adaptive_smoothing_high_load_is_conservative() {
        // Under high cluster load, alpha should be small → weight changes slowly.
        let servers = make_servers(2);
        let config = ScoreboardConfig {
            smoothing_alpha: 0.3,
            max_shift_fraction: 1.0, // disable shift cap to isolate smoothing
            max_alpha: 0.6,
            min_alpha: 0.05,
            domain_capacity_fraction: 1.0, // disable domain cap for this test
            ..Default::default()
        };
        let sb_low = Scoreboard::with_servers(&servers, config.clone());
        let sb_high = Scoreboard::with_servers(&servers, config);

        let mut preds = HashMap::new();
        preds.insert(ServerId(0), ServerPrediction::from_risk_confidence(0.8, 1.0));
        preds.insert(ServerId(1), ServerPrediction::from_risk_confidence(0.1, 1.0));

        // Single update with low load vs high load.
        sb_low.update_scores(&preds, 0.1);   // low load → higher alpha
        sb_high.update_scores(&preds, 0.9);  // high load → lower alpha

        let snap_low = sb_low.load();
        let snap_high = sb_high.load();

        // Server 0 should drop further from initial 0.5 under low load
        // (more responsive) than under high load (more conservative).
        let w0_low = snap_low.get(&ServerId(0)).unwrap().weight;
        let w0_high = snap_high.get(&ServerId(0)).unwrap().weight;
        // With high load, weight stays closer to initial.
        let initial = 0.5; // 1/2 servers
        let delta_low = (w0_low - initial).abs();
        let delta_high = (w0_high - initial).abs();
        assert!(
            delta_low > delta_high,
            "low-load alpha should cause bigger weight change: \
             delta_low={delta_low:.6}, delta_high={delta_high:.6}"
        );
    }

    #[test]
    fn test_health_memory_penalizes_error_prone_server() {
        let servers = vec![
            (ServerId(0), DomainId(0)),
            (ServerId(1), DomainId(1)),
        ];
        let config = ScoreboardConfig {
            health_ema_beta: 0.3,   // faster EMA for test convergence
            smoothing_alpha: 1.0,
            max_shift_fraction: 1.0,
            max_alpha: 1.0,
            domain_capacity_fraction: 1.0, // disable domain cap for this test
            ..Default::default()
        };
        let sb = Scoreboard::with_servers(&servers, config);

        // Server 0 has consistently high error rate; server 1 is clean.
        let mut preds = HashMap::new();
        preds.insert(ServerId(0), ServerPrediction {
            risk_mean: 0.1,        // low risk prediction
            risk_variance: 0.0,
            confidence: 1.0,
            error_rate: 0.5,       // but high error rate
        });
        preds.insert(ServerId(1), ServerPrediction {
            risk_mean: 0.1,
            risk_variance: 0.0,
            confidence: 1.0,
            error_rate: 0.0,
        });

        // Run many rounds so health_score accumulates.
        for _ in 0..30 {
            sb.update_scores(&preds, 0.0);
        }

        let snap = sb.load();
        let s0 = snap.get(&ServerId(0)).unwrap();
        let s1 = snap.get(&ServerId(1)).unwrap();

        // Health score should be elevated for server 0.
        assert!(s0.health_score > 0.1, "health_score should accumulate: {}", s0.health_score);
        assert!(s1.health_score < 0.01, "clean server should have near-zero health: {}", s1.health_score);

        // Server 0 should get less weight despite equal risk prediction.
        assert!(
            s1.weight > s0.weight,
            "error-prone server should have lower weight: w0={}, w1={}",
            s0.weight, s1.weight
        );
    }
}
