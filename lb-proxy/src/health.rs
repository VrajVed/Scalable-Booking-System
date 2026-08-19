//! Per-backend runtime health tracking.
//!
//! This is the "real health signals" half of the feedback loop. It keeps:
//!   - in-flight request count (atomic, bumped on dispatch, dropped on finish)
//!   - a sliding window of recent request timestamps and 5xx timestamps
//!   - an EMA of observed response-head latency
//!
//! Every completed proxied request funnels through `record()`, producing the two
//! inputs the router-core router consumes: the `FastHealthSignals` snapshot for
//! the immediate per-request safety override, and the scoreboard prediction
//! (risk + error_rate) that slowly re-weights the backend pool.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use http::StatusCode;
use router_core::FastHealthSignals;

const EMPTY_EMA_SENTINEL: u64 = 0;

pub struct ServerHealth {
    in_flight: AtomicU64,
    all_requests: Mutex<VecDeque<Instant>>,
    five_xx: Mutex<VecDeque<Instant>>,
    latency_ema_ns: AtomicU64,
    total_requests: AtomicU64,
}

impl ServerHealth {
    pub fn new() -> Self {
        Self {
            in_flight: AtomicU64::new(0),
            all_requests: Mutex::new(VecDeque::new()),
            five_xx: Mutex::new(VecDeque::new()),
            latency_ema_ns: AtomicU64::new(EMPTY_EMA_SENTINEL),
            total_requests: AtomicU64::new(0),
        }
    }

    /// Called when a request is dispatched to this backend.
    #[inline]
    pub fn begin(&self) {
        self.in_flight.fetch_add(1, Ordering::Relaxed);
    }

    /// Called when the response has been fully consumed (or the backend call failed).
    #[inline]
    pub fn decrement(&self) {
        self.in_flight.fetch_sub(1, Ordering::Relaxed);
    }

    /// Record a completed request's outcome. Does not touch `in_flight` — that
    /// is handled by `begin`/`decrement` so the deferral of the decrement to
    /// response-body completion stays explicit.
    pub fn record(&self, status: StatusCode, latency: Duration, window: Duration) {
        let now = Instant::now();

        {
            let mut all = self.all_requests.lock().unwrap();
            prune(&mut all, now, window);
            all.push_back(now);
        }

        if status.is_server_error() {
            let mut errs = self.five_xx.lock().unwrap();
            prune(&mut errs, now, window);
            errs.push_back(now);
        }

        self.update_latency_ema(latency);
        self.total_requests.fetch_add(1, Ordering::Relaxed);
    }

    /// Current fast-path snapshot fed to `Router::choose_server` on the next
    /// decision. `backlog` is left at 0 (unobservable behind a pooled client).
    pub fn snapshot(&self, window: Duration) -> FastHealthSignals {
        FastHealthSignals {
            backlog: 0,
            error_5xx_count: self.five_xx_count(window),
            in_flight: self.in_flight.load(Ordering::Relaxed),
        }
    }

    /// Number of 5xx responses observed in the sliding window.
    pub fn five_xx_count(&self, window: Duration) -> u64 {
        let mut errs = self.five_xx.lock().unwrap();
        // prune takes `now` internally so expired entries never get counted
        let now = Instant::now();
        prune(&mut errs, now, window);
        errs.len() as u64
    }

    /// Fraction of requests in the sliding window that returned 5xx. Used as
    /// router-core's `ServerPrediction::error_rate` input.
    pub fn error_rate(&self, window: Duration) -> f64 {
        let total = {
            let mut all = self.all_requests.lock().unwrap();
            let now = Instant::now();
            prune(&mut all, now, window);
            all.len()
        };
        if total == 0 {
            return 0.0;
        }
        self.five_xx_count(window) as f64 / total as f64
    }

    /// Lifetime count of recorded completions (used to ramp confidence).
    pub fn total_requests(&self) -> u64 {
        self.total_requests.load(Ordering::Relaxed)
    }

    /// EMA (nanos) of response-head latency.
    pub fn latency_ema_ns(&self) -> u64 {
        self.latency_ema_ns.load(Ordering::Relaxed)
    }

    fn update_latency_ema(&self, latency: Duration) {
        let lat_ns = latency.as_nanos() as u64;
        let mut cur = self.latency_ema_ns.load(Ordering::Relaxed);
        loop {
            let next = if cur == EMPTY_EMA_SENTINEL {
                lat_ns
            } else {
                // 0.9 * old + 0.1 * new, in integer nanos (cheap, no allocation)
                (cur.saturating_mul(9) / 10) + (lat_ns / 10)
            };
            match self
                .latency_ema_ns
                .compare_exchange_weak(cur, next, Ordering::Relaxed, Ordering::Relaxed)
            {
                Ok(_) => break,
                Err(actual) => cur = actual,
            }
        }
    }
}

fn prune(entries: &mut VecDeque<Instant>, now: Instant, window: Duration) {
    while let Some(&oldest) = entries.front() {
        if now.duration_since(oldest) <= window {
            break;
        }
        entries.pop_front();
    }
}

impl Default for ServerHealth {
    fn default() -> Self {
        Self::new()
    }
}