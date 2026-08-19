// =============================================================================
// types.rs — Core type definitions for the predictive load balancer
// =============================================================================
//
// Design rationale:
//   - ServerId is a lightweight Copy type for zero-cost passing in the hot path.
//   - DomainId groups servers that share failure domains (rack, DB, switch).
//   - ServerScore carries the ML prediction output plus routing metadata.
//   - All types derive Clone so they can be cheaply shared across the RCU boundary.
// =============================================================================

use std::time::Instant;

/// Unique identifier for a backend server.
/// Uses u64 for compact representation and cheap Copy semantics.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct ServerId(pub u64);

/// Failure-domain identifier.  Servers in the same domain share correlated
/// failure modes (same rack, same database, same network switch, etc.).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct DomainId(pub u64);

/// Score produced by the ML inference engine for a single backend server.
///
/// The router never computes these — it only reads them from the scoreboard.
#[derive(Debug, Clone)]
pub struct ServerScore {
    /// Probability that the server will violate the latency SLO in the near
    /// future.  Range: [0.0, 1.0].  Higher means more likely to degrade.
    pub risk: f64,

    /// Model confidence in the risk prediction.  Range: [0.0, 1.0].
    /// Low confidence causes the router to bias toward round-robin fallback.
    pub confidence: f64,

    /// Derived routing weight.  Computed as `exp(-effective_risk) * exp(-health_score)`
    /// then smoothed and capped by the scoreboard update logic.  Higher weight → more traffic.
    pub weight: f64,

    /// Wall-clock instant when this score was last refreshed.
    /// The router uses this to detect staleness and fall back to safe routing.
    pub updated_at: Instant,

    /// Failure domain this server belongs to.
    pub domain: DomainId,

    /// EMA-smoothed health score tracking long-term error patterns.
    /// Range: [0.0, 1.0].  Higher means more historically unhealthy.
    /// Used to implement slow recovery ramp-up for servers that fail in cycles.
    /// Updated via: health_t = β * error_rate + (1−β) * health_(t−1)
    pub health_score: f64,
}

impl ServerScore {
    /// Create a new score with sensible defaults (neutral risk, full confidence).
    pub fn new(domain: DomainId) -> Self {
        Self {
            risk: 0.0,
            confidence: 1.0,
            weight: 1.0,
            updated_at: Instant::now(),
            domain,
            health_score: 0.0,
        }
    }
}

/// Per-server prediction from the ML inference engine.
///
/// Replaces the raw `(risk, confidence)` tuple to support richer prediction
/// data including uncertainty estimation (MC Dropout) and health tracking.
#[derive(Debug, Clone)]
pub struct ServerPrediction {
    /// Mean predicted risk from MC Dropout ensemble.  Range: [0.0, 1.0].
    /// In TTF mode this is `1 / predicted_time_to_failure`, clamped to [0, 1].
    pub risk_mean: f64,

    /// Variance of the risk prediction from MC Dropout.
    /// Higher variance → less certain → router should be more conservative.
    /// Default 0.0 means no uncertainty information available.
    pub risk_variance: f64,

    /// Model confidence in the prediction.  Range: [0.0, 1.0].
    pub confidence: f64,

    /// Recent error rate observed for this server.  Range: [0.0, 1.0].
    /// Fed into the health-memory EMA to track long-term reliability.
    pub error_rate: f64,
}

impl ServerPrediction {
    /// Create from legacy (risk, confidence) tuple for backward compatibility.
    pub fn from_risk_confidence(risk: f64, confidence: f64) -> Self {
        Self {
            risk_mean: risk,
            risk_variance: 0.0,
            confidence,
            error_rate: 0.0,
        }
    }
}

/// Fast-path health signals that the router collects locally (no ML involved).
/// These override ML predictions when they indicate immediate danger.
#[derive(Debug, Clone, Default)]
pub struct FastHealthSignals {
    /// Current connection backlog (TCP accept queue depth).
    pub backlog: u64,
    /// Count of 5xx errors observed in the last short window.
    pub error_5xx_count: u64,
    /// Number of requests currently in-flight to this server.
    pub in_flight: u64,
}

/// Thresholds for the fast safety override system.
/// When any signal exceeds its threshold the server is temporarily penalized
/// regardless of what the ML model predicted.
#[derive(Debug, Clone)]
pub struct SafetyThresholds {
    pub max_backlog: u64,
    pub max_5xx_count: u64,
    pub max_in_flight: u64,
}

impl Default for SafetyThresholds {
    fn default() -> Self {
        Self {
            max_backlog: 100,
            max_5xx_count: 10,
            max_in_flight: 500,
        }
    }
}

/// Configuration for the scoreboard update algorithm.
#[derive(Debug, Clone)]
pub struct ScoreboardConfig {
    /// Base exponential smoothing factor α (also used as base for adaptive smoothing).
    /// new_weight = α * predicted + (1−α) * previous.
    /// Lower values mean slower, more stable transitions.
    pub smoothing_alpha: f64,

    /// Maximum fractional change allowed per update cycle.
    /// Prevents thundering-herd oscillations.
    /// E.g., 0.10 means weight can shift at most ±10% per update.
    pub max_shift_fraction: f64,

    /// Maximum fraction of total traffic that any single failure domain
    /// may receive.  Prevents correlated-failure concentration.
    pub domain_capacity_fraction: f64,

    /// Exploration floor: minimum weight any server can have.
    /// Ensures dead nodes still receive a trickle of health-probe traffic.
    /// Typical value: 0.03–0.05 (3–5%).
    pub min_weight: f64,

    /// Scores older than this duration are considered stale.
    /// The router falls back to equal-weight routing for stale servers.
    pub staleness_ttl: std::time::Duration,

    // ── Adaptive smoothing (Improvement 3) ──

    /// Minimum smoothing factor.  At high cluster load, α is reduced toward
    /// this floor to make weight transitions more conservative.
    pub min_alpha: f64,

    /// Maximum smoothing factor.  At low cluster load, α can increase up to
    /// this ceiling to make the system more responsive.
    pub max_alpha: f64,

    // ── Prediction uncertainty (Improvement 1) ──

    /// Risk aversion coefficient λ for uncertainty-adjusted routing.
    /// effective_risk = risk_mean + λ * sqrt(risk_variance).
    /// Higher λ → more conservative under uncertainty.
    /// 0.0 disables uncertainty adjustment (backward compatible).
    pub risk_aversion_lambda: f64,

    // ── Server health memory (Improvement 4) ──

    /// EMA decay factor β for the health score.
    /// health_t = β * error_rate + (1−β) * health_(t−1).
    /// Small β (≈ 0.1) gives long memory; large β reacts faster.
    pub health_ema_beta: f64,
}

impl Default for ScoreboardConfig {
    fn default() -> Self {
        Self {
            smoothing_alpha: 0.3,
            max_shift_fraction: 0.10,
            domain_capacity_fraction: 0.40,
            min_weight: 0.03,
            staleness_ttl: std::time::Duration::from_secs(5),
            min_alpha: 0.05,
            max_alpha: 0.6,
            risk_aversion_lambda: 0.0,
            health_ema_beta: 0.1,
        }
    }
}
