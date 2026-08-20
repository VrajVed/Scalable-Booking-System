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

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    /// Fire many concurrent `record()` calls from real parallel tokio tasks
    /// (not sequential awaits) and confirm every completion is accounted for
    /// exactly once. `total_requests` is a plain atomic fetch_add so it must
    /// match the call count exactly; if the sliding-window deques lost
    /// updates under contention, `all_requests` length (post-prune, but we
    /// use a window bigger than the whole test so nothing prunes) would also
    /// undercount.
    #[tokio::test(flavor = "multi_thread", worker_threads = 8)]
    async fn concurrent_record_has_no_lost_updates() {
        let health = Arc::new(ServerHealth::new());
        let window = Duration::from_secs(60); // long enough nothing prunes mid-test
        let tasks_n = 50;
        let per_task = 200;

        let mut handles = Vec::new();
        for i in 0..tasks_n {
            let h = health.clone();
            handles.push(tokio::spawn(async move {
                for j in 0..per_task {
                    // Mix of ok/error statuses so both deques get contended.
                    let status = if (i + j) % 7 == 0 {
                        StatusCode::INTERNAL_SERVER_ERROR
                    } else {
                        StatusCode::OK
                    };
                    h.record(status, Duration::from_micros(1), window);
                }
            }));
        }
        for h in handles {
            h.await.unwrap();
        }

        let expected = tasks_n * per_task;
        assert_eq!(
            health.total_requests(),
            expected as u64,
            "lost updates under concurrent record()"
        );

        // Sliding window count (nothing pruned: window is huge) must match too.
        let all_count = {
            let mut all = health.all_requests.lock().unwrap();
            prune(&mut all, Instant::now(), window);
            all.len()
        };
        assert_eq!(all_count, expected, "all_requests deque lost entries under contention");

        // Expected 5xx count: for i in 0..50, j in 0..200, (i+j)%7==0.
        let mut expected_5xx = 0u64;
        for i in 0..tasks_n {
            for j in 0..per_task {
                if (i + j) % 7 == 0 {
                    expected_5xx += 1;
                }
            }
        }
        assert_eq!(health.five_xx_count(window), expected_5xx);
    }

    /// Concurrent `record()` + `snapshot()` + `begin`/`decrement` from many
    /// tasks at once must not panic or deadlock, and in_flight must return to
    /// exactly zero once every task's begin() is matched by a decrement().
    #[tokio::test(flavor = "multi_thread", worker_threads = 8)]
    async fn concurrent_mixed_access_no_panic_balanced_in_flight() {
        let health = Arc::new(ServerHealth::new());
        let window = Duration::from_millis(50);

        let mut handles = Vec::new();
        for _ in 0..64 {
            let h = health.clone();
            handles.push(tokio::spawn(async move {
                h.begin();
                let _ = h.snapshot(window);
                h.record(StatusCode::OK, Duration::from_micros(5), window);
                let _ = h.error_rate(window);
                h.decrement();
            }));
        }
        for h in handles {
            h.await.unwrap();
        }

        assert_eq!(
            health.snapshot(window).in_flight,
            0,
            "in_flight must balance back to zero after matched begin/decrement pairs"
        );
    }

    /// The sliding window is inclusive at the boundary: `prune` only drops
    /// entries strictly older than `window` (`duration_since(oldest) <=
    /// window` is kept). We can't control `Instant::now()` directly, so we
    /// approximate the boundary with real sleeps: shortly before `window`
    /// elapses the event must still be counted, and comfortably after it
    /// must be gone. This nails down the *direction* of the boundary
    /// (inclusive-recent, not the reverse) without relying on exact timing.
    #[tokio::test]
    async fn sliding_window_expires_after_window_elapses() {
        let health = ServerHealth::new();
        let window = Duration::from_millis(120);

        health.record(StatusCode::INTERNAL_SERVER_ERROR, Duration::from_micros(1), window);
        assert_eq!(health.five_xx_count(window), 1, "event must count immediately after recording");

        tokio::time::sleep(Duration::from_millis(40)).await;
        assert_eq!(
            health.five_xx_count(window),
            1,
            "event well within the window must still be counted"
        );

        tokio::time::sleep(Duration::from_millis(140)).await; // total ~180ms > 120ms window
        assert_eq!(
            health.five_xx_count(window),
            0,
            "event older than the window must be pruned"
        );
    }

    #[test]
    fn error_rate_is_zero_with_no_requests() {
        let health = ServerHealth::new();
        assert_eq!(health.error_rate(Duration::from_secs(10)), 0.0);
    }

    #[test]
    fn error_rate_reflects_ratio_of_5xx_to_total() {
        let health = ServerHealth::new();
        let window = Duration::from_secs(10);
        // 3 ok, 1 error => 25% error rate.
        health.record(StatusCode::OK, Duration::from_micros(1), window);
        health.record(StatusCode::OK, Duration::from_micros(1), window);
        health.record(StatusCode::OK, Duration::from_micros(1), window);
        health.record(StatusCode::INTERNAL_SERVER_ERROR, Duration::from_micros(1), window);
        assert!((health.error_rate(window) - 0.25).abs() < 1e-9);
    }
}