//! The reverse proxy core.
//!
//! Flow per incoming request:
//!   1. Snapshot per-backend fast health signals (in-flight, 5xx window).
//!   2. Ask `router_core::Router::choose_server` which backend to use.
//!   3. Forward method + headers + body to that backend (streaming).
//!   4. Stream the backend response back to the caller.
//!   5. When the response completes, feed latency + 5xx + in-flight back into
//!      the shared health registry AND router-core's scoreboard, so the *next*
//!      routing decision reflects real backend health.
//!
//! The proxy has zero policy of its own: no auth, no rate limiting, no request
//! rewriting. Backends already enforce that.

use std::collections::HashMap;
use std::convert::Infallible;
use std::net::SocketAddr;
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::task::{Context, Poll};
use std::time::{Duration, Instant};

use bytes::Bytes;
use http::header::HeaderName;
use http::{HeaderMap, Method, Request, Response, StatusCode, Uri};
use http_body::{Body, Frame, SizeHint};
use http_body_util::combinators::BoxBody;
use http_body_util::{BodyExt, Full};
use hyper::body::Incoming;
use hyper::service::service_fn;
use hyper_util::client::legacy::connect::HttpConnector;
use hyper_util::client::legacy::Client;
use hyper_util::rt::{TokioExecutor, TokioIo};
use hyper_util::server::graceful::GracefulShutdown;
use router_core::{
    DomainId, FastHealthSignals, Router, Scoreboard, ScoreboardConfig, ServerId, ServerPrediction,
};

use crate::config::{Config, RoutingAlgorithm};
use crate::health::ServerHealth;

type BoxErr = Box<dyn std::error::Error + Send + Sync>;
type ProxyClient = Client<HttpConnector, BoxBody<Bytes, BoxErr>>;

/// Shared proxy state. Cloned cheaply (`Arc`) into every connection.
pub struct ProxyState {
    /// The P2C routing engine (owns the ArcSwap scoreboard).
    ///
    /// router-core's `Router` uses a `Cell<u64>` for its thread-local PRNG and
    /// is therefore not `Sync` — it cannot be shared across threads via `Arc`.
    /// A plain `Mutex` restores `Send + Sync`; the critical section is a single
    /// <1µs `choose_server` call, so contention is negligible.
    router: Mutex<Router>,
    /// Pooled HTTP/1.1 client used for outbound calls to backends.
    client: ProxyClient,
    /// Upstream URLs; index `i` ↔ `ServerId(i)`.
    backends: Vec<String>,
    /// Per-backend health registry, mutated on every completed request.
    registry: RwLock<HashMap<ServerId, Arc<ServerHealth>>>,
    latency_slo: Duration,
    five_xx_window: Duration,
    /// Interval at which the background loop turns observed health into
    /// scoreboard predictions (router-core's "slow loop").
    health_poll: Duration,
    /// Requests routed by this proxy (for diagnostics / tests).
    requests_total: AtomicU64,
    /// Routing decision to use — see `RoutingAlgorithm`. `RoundRobin` exists
    /// only for the load-test harness to compare against P2C through this
    /// same binary/network path; every other field above still gets fed
    /// real health data in that mode too, so per-request overhead stays
    /// identical between modes and only the selection differs.
    algorithm: RoutingAlgorithm,
    /// Cursor for `RoutingAlgorithm::RoundRobin`. Unused under P2c.
    rr_cursor: AtomicU64,
}

impl ProxyState {
    /// Build the proxy state and spawn the background health-sync loop.
    ///
    /// Requires an active tokio runtime (it calls `tokio::spawn`).
    pub fn new(cfg: Config) -> Arc<Self> {
        let n = cfg.backend_pool.len();
        let server_domains: Vec<(ServerId, DomainId)> =
            (0..n).map(|i| (ServerId(i as u64), DomainId(0))).collect();
        let server_ids: Vec<ServerId> = server_domains.iter().map(|&(s, _)| s).collect();

        let scoreboard =
            Scoreboard::with_servers(&server_domains, ScoreboardConfig::default());
        let router = Router::new(scoreboard, server_ids.clone(), cfg.safety);

        let mut registry_map = HashMap::with_capacity(server_ids.len());
        for &sid in &server_ids {
            registry_map.insert(sid, Arc::new(ServerHealth::new()));
        }

        let client = Client::builder(TokioExecutor::new()).build_http();

        let state = Arc::new(Self {
            router: Mutex::new(router),
            client,
            backends: cfg.backend_pool,
            registry: RwLock::new(registry_map),
            latency_slo: cfg.latency_slo,
            five_xx_window: cfg.five_xx_window,
            health_poll: cfg.health_poll,
            requests_total: AtomicU64::new(0),
            algorithm: cfg.algorithm,
            rr_cursor: AtomicU64::new(0),
        });

        tokio::spawn(state.clone().health_loop());

        state
    }

    pub fn backends(&self) -> &[String] {
        &self.backends
    }

    pub fn requests_total(&self) -> u64 {
        self.requests_total.load(Ordering::Relaxed)
    }

    fn backend_url(&self, sid: ServerId) -> &str {
        &self.backends[sid.0 as usize]
    }

    fn server_health(&self, sid: ServerId) -> Option<Arc<ServerHealth>> {
        self.registry.read().ok()?.get(&sid).cloned()
    }

    /// Construct the `FastHealthSignals` map passed to the router on each
    /// decision: real in-flight counts and 5xx-window counts, per backend.
    fn snapshot_signals(&self) -> HashMap<ServerId, FastHealthSignals> {
        let reg = self.registry.read().unwrap();
        let mut signals = HashMap::with_capacity(reg.len());
        for (&sid, health) in reg.iter() {
            signals.insert(sid, health.snapshot(self.five_xx_window));
        }
        signals
    }

    /// Feed the observed outcome of one proxied request back into the fast-path
/// health registry. This runs on the *request path* (per-request, cheap: a few
/// atomic ops + window bookkeeping); the scoreboard is reconciled on a slow
/// loop by `health_loop`.
    fn record_backend_health(&self, sid: ServerId, status: StatusCode, latency: Duration) {
        if let Some(health) = self.server_health(sid) {
            health.record(status, latency, self.five_xx_window);
        }
    }

    /// Slow loop: every `health_poll`, turn the registry's observed health into
    /// a fresh prediction set for *every* backend and push it into the
    /// scoreboard. This mirrors router-core's designed "ML inference loop"
    /// (100–500ms) — slow, smoothed, whole-pool — while the fast path supplies
    /// immediate per-request safety overrides.
    async fn health_loop(self: Arc<Self>) {
        let mut tick = tokio::time::interval(self.health_poll);
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            tick.tick().await;
            self.sync_scoreboard();
        }
    }

    /// Push current predictions for every backend into the scoreboard.
    ///
    /// Risk is derived from the latency EMA relative to the SLO, error_rate
    /// from the 5xx sliding window. router-core's smoothing / max-shift /
    /// health-memory invariants then re-weight the pool.
    fn sync_scoreboard(&self) {
        let predictions = {
            let reg = self.registry.read().unwrap();
            let mut predictions = HashMap::with_capacity(reg.len());
            let slo_ns = self.latency_slo.as_nanos() as f64;

            for (&sid, health) in reg.iter() {
                if health.total_requests() == 0 {
                    // Never measured — neutral prediction.
                    predictions.insert(
                        sid,
                        ServerPrediction {
                            risk_mean: 0.0,
                            risk_variance: 0.0,
                            confidence: 0.0,
                            error_rate: 0.0,
                        },
                    );
                    continue;
                }

                let ema_ns = health.latency_ema_ns() as f64;
                let denom = (slo_ns + ema_ns).max(1.0);
                let risk = 1.0 - slo_ns / denom;
                let error_rate = health.error_rate(self.five_xx_window);
                let confidence = (health.total_requests() as f64 / 10.0).min(1.0);

                predictions.insert(
                    sid,
                    ServerPrediction {
                        risk_mean: risk.clamp(0.0, 1.0),
                        risk_variance: 0.0,
                        confidence,
                        error_rate,
                    },
                );
            }
            predictions
        };

        let router = self.router.lock().unwrap();
        router.scoreboard().update_scores(&predictions, 0.0);
    }
}

/// Wrap a response body so `on_done` fires exactly once when the body is fully
/// drained (or the connection dies mid-stream). Used to decrement the backend's
/// in-flight count only once the proxied response is actually finished — the
/// backend connection is held for the whole stream.
struct TrackedBody<B> {
    inner: B,
    done: bool,
    on_done: Option<Box<dyn FnOnce() + Send + Sync>>,
}

impl<B> TrackedBody<B> {
    fn new(inner: B, on_done: impl FnOnce() + Send + Sync + 'static) -> Self {
        Self {
            inner,
            done: false,
            on_done: Some(Box::new(on_done)),
        }
    }

    fn finish(&mut self) {
        if !self.done {
            self.done = true;
            if let Some(f) = self.on_done.take() {
                f();
            }
        }
    }
}

impl<B: Body + Unpin> Body for TrackedBody<B> {
    type Data = B::Data;
    type Error = B::Error;

    fn poll_frame(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Self::Data>, Self::Error>>> {
        let poll = Pin::new(&mut self.inner).poll_frame(cx);
        match &poll {
            Poll::Ready(None) | Poll::Ready(Some(Err(_))) => self.finish(),
            _ => {}
        }
        poll
    }

    fn is_end_stream(&self) -> bool {
        self.inner.is_end_stream()
    }

    fn size_hint(&self) -> SizeHint {
        self.inner.size_hint()
    }
}

impl<B> Drop for TrackedBody<B> {
    fn drop(&mut self) {
        self.finish();
    }
}

/// Header fields we must not forward across a proxy hop. `content-length` is
/// stripped as well: the outbound HTTP/1.1 client re-derives framing from the
/// streamed body.
fn strip_hop_by_hop(headers: &mut HeaderMap) {
    for name in [
        "connection",
        "keep-alive",
        "proxy-authenticate",
        "proxy-authorization",
        "te",
        "trailer",
        "transfer-encoding",
        "upgrade",
        "host",
        "content-length",
    ] {
        headers.remove(HeaderName::from_static(name));
    }
}

/// Trust boundary: in this deployment lb-proxy is the ONLY hop between the
/// internet-facing ingress and the backends, so backends derive the client IP
/// from `X-Forwarded-For` trusting exactly this one hop (the backend's Fastify
/// `trustProxy`). This proxy therefore *overwrites* `X-Forwarded-For` with the
/// actual TCP peer IP of the accepted inbound connection — a client-supplied
/// value is discarded, not appended to. Appending would let a client
/// pre-populate the chain so their forged entry survives as the trusted (or
/// rate-limit-keying) value; overwriting means the backend only ever sees the
/// IP this proxy itself observed. A client can neither rotate the header per
/// request to dodge backend rate limiting nor spoof a victim's IP into it.
fn set_forwarded_for(headers: &mut HeaderMap, peer: SocketAddr) {
    let value = http::HeaderValue::from_str(&peer.ip().to_string())
        .expect("a peer IP address is always a valid header value");
    headers.insert(HeaderName::from_static("x-forwarded-for"), value);
}

/// How long the drain phase of `run_until` waits for in-flight connections
/// to finish after a shutdown signal before giving up and returning anyway.
/// Kept comfortably under Kubernetes' default `terminationGracePeriodSeconds`
/// (30s) so we return control to `main` — and print a clear diagnostic —
/// before the kubelet SIGKILLs the process out from under us.
const DRAIN_TIMEOUT: Duration = Duration::from_secs(25);

/// Event-loop entry point: accept connections and serve the proxy service,
/// stopping (and draining in-flight connections) as soon as `shutdown`
/// resolves. Pass `std::future::pending()` for a shutdown that never fires
/// (e.g. in tests that don't care about graceful shutdown) to run forever.
///
/// Stopping (bounded by [`DRAIN_TIMEOUT`]) once every already-accepted
/// connection finishes, rather than dying the instant `shutdown` resolves,
/// is what lets the proxy survive a Kubernetes pod termination (SIGTERM
/// during a rolling update / scale-down) without cutting off in-flight
/// requests: kubelet sends SIGTERM, keeps routing traffic to the pod for a
/// moment longer, then waits up to `terminationGracePeriodSeconds` before
/// SIGKILL. Dying immediately on SIGTERM turns every deploy or scale-down
/// event into a burst of dropped connections for whatever was in flight at
/// that instant.
pub async fn run_until(
    listener: tokio::net::TcpListener,
    state: Arc<ProxyState>,
    shutdown: impl std::future::Future<Output = ()>,
) {
    let graceful = GracefulShutdown::new();
    let mut shutdown = std::pin::pin!(shutdown);

    loop {
        tokio::select! {
            // Prefer observing shutdown over accepting one more connection
            // when both are ready in the same poll.
            biased;
            _ = &mut shutdown => {
                println!("[lb-proxy] shutdown signal received; no longer accepting new connections, draining in-flight...");
                break;
            }
            accept_res = listener.accept() => {
                match accept_res {
                    Ok((stream, peer)) => {
                        let io = TokioIo::new(stream);
                        let st = state.clone();
                        let svc = service_fn(move |req| {
                            let st = st.clone();
                            async move { handle(&st, req, peer).await }
                        });
                        let conn = hyper::server::conn::http1::Builder::new().serve_connection(io, svc);
                        let conn = graceful.watch(conn);
                        tokio::spawn(async move {
                            if let Err(e) = conn.await {
                                eprintln!("[lb-proxy] connection error: {e}");
                            }
                        });
                    }
                    Err(e) => eprintln!("[lb-proxy] accept error: {e}"),
                }
            }
        }
    }

    match tokio::time::timeout(DRAIN_TIMEOUT, graceful.shutdown()).await {
        Ok(()) => println!("[lb-proxy] all in-flight connections drained cleanly, exiting"),
        Err(_) => eprintln!(
            "[lb-proxy] drain timeout ({DRAIN_TIMEOUT:?}) exceeded with connections still in flight, exiting anyway"
        ),
    }
}

/// Handle a single incoming request.
///
/// `peer` is the address of the TCP connection this proxy itself accepted —
/// the only client-supplied information that can be believed.
async fn handle(
    state: &Arc<ProxyState>,
    req: Request<Incoming>,
    peer: SocketAddr,
) -> Result<Response<BoxBody<Bytes, BoxErr>>, Infallible> {
    // The proxy's own readiness probe — never routed to a backend.
    if req.method() == Method::GET
        && req.uri().path() == "/health"
    {
        return Ok(health_response(state));
    }

    // Prometheus scrape target — same never-routed-to-a-backend rule as /health.
    if req.method() == Method::GET && req.uri().path() == "/metrics" {
        return Ok(metrics_response(state));
    }

    let (parts, body) = req.into_parts();
    let method = parts.method.clone();
    let path_and_query = parts
        .uri
        .path_and_query()
        .map(|pq| pq.as_str().to_string())
        .unwrap_or_else(|| "/".to_string());

    // 1. Routing decision. Health signals are always snapshotted and fed to
    //    router-core's scoreboard below regardless of algorithm, so the two
    //    modes pay identical per-request overhead and only the selection
    //    itself differs — see `RoutingAlgorithm` for why this matters.
    let signals = state.snapshot_signals();
    let Some(sid) = (match state.algorithm {
        RoutingAlgorithm::P2c => state.router.lock().unwrap().choose_server(&signals),
        RoutingAlgorithm::RoundRobin => {
            let n = state.backends.len() as u64;
            if n == 0 {
                None
            } else {
                let i = state.rr_cursor.fetch_add(1, Ordering::Relaxed) % n;
                Some(ServerId(i))
            }
        }
    }) else {
        return Ok(text_response(StatusCode::SERVICE_UNAVAILABLE, "no backends configured"));
    };

    let Some(health) = state.server_health(sid) else {
        return Ok(text_response(StatusCode::SERVICE_UNAVAILABLE, "backend disappeared"));
    };

    health.begin();
    state.requests_total.fetch_add(1, Ordering::Relaxed);

    // 2. Build the outbound request: same method + path, forwarded headers,
    //    streamed body.
    let target_uri: Uri = match format!("{}{}", state.backend_url(sid), path_and_query).parse() {
        Ok(uri) => uri,
        Err(e) => {
            eprintln!("[lb-proxy] bad target uri: {e}");
            health.decrement();
            return Ok(text_response(StatusCode::BAD_GATEWAY, "invalid upstream target"));
        }
    };

    let mut out_headers = parts.headers.clone();
    strip_hop_by_hop(&mut out_headers);
    let host = target_uri
        .authority()
        .map(|a| a.to_string())
        .unwrap_or_default();
    out_headers.insert(http::header::HOST, host.parse().unwrap());
    // Set the client-identity header AFTER the hop-by-hop strip, from the
    // address of the connection we actually accepted — never from the
    // client's own header values (see `set_forwarded_for`).
    set_forwarded_for(&mut out_headers, peer);

    let mut out_req = Request::builder().method(&method).uri(target_uri);
    for (name, value) in out_headers.iter() {
        out_req = out_req.header(name, value);
    }

    let boxed_body: BoxBody<Bytes, BoxErr> = body.map_err(Into::into).boxed();
    let out_req = match out_req.body(boxed_body) {
        Ok(r) => r,
        Err(e) => {
            eprintln!("[lb-proxy] failed to build outbound request: {e}");
            health.decrement();
            return Ok(text_response(StatusCode::BAD_GATEWAY, "failed to build request"));
        }
    };

    // 3. Forward + stream.
    let start = Instant::now();
    match state.client.request(out_req).await {
        Ok(resp) => {
            let latency = start.elapsed();
            let (resp_parts, resp_body) = resp.into_parts();
            let status = resp_parts.status;

            // 4. Feed health back now (latency + 5xx into scoreboard/window).
            state.record_backend_health(sid, status, latency);

            // 5. Decrement in-flight only when the streamed body completes.
            let health_for_done = health.clone();
            let on_done = move || health_for_done.decrement();
            let tracked = TrackedBody::new(resp_body, on_done);
            let boxed: BoxBody<Bytes, BoxErr> = tracked.map_err(Into::into).boxed();

            Ok(Response::from_parts(resp_parts, boxed))
        }
        Err(e) => {
            let latency = start.elapsed();
            // Connection to the chosen backend failed — treat as a 5xx-class
            // health event and release the in-flight slot immediately.
            health.decrement();
            state.record_backend_health(sid, StatusCode::BAD_GATEWAY, latency);
            eprintln!(
                "[lb-proxy] upstream error for server {:?}: {e}",
                sid
            );
            Ok(text_response(
                StatusCode::BAD_GATEWAY,
                "upstream request failed",
            ))
        }
    }
}

fn health_response(state: &ProxyState) -> Response<BoxBody<Bytes, BoxErr>> {
    let backends: Vec<serde_json::Value> = state
        .backends()
        .iter()
        .enumerate()
        .map(|(i, url)| {
            let sid = ServerId(i as u64);
            let (in_flight, five_xx) = match state.server_health(sid) {
                Some(h) => (
                    h.snapshot(state.five_xx_window).in_flight,
                    h.five_xx_count(state.five_xx_window),
                ),
                None => (0, 0),
            };
            serde_json::json!({
                "id": i,
                "url": url,
                "in_flight": in_flight,
                "five_xx_in_window": five_xx,
            })
        })
        .collect();

    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);

    let body = serde_json::json!({
        "status": "ok",
        "timestamp_ms": now_ms,
        "requests_total": state.requests_total(),
        "backends": backends,
    });

    let mut resp = Response::new(box_json(&body));
    *resp.status_mut() = StatusCode::OK;
    resp.headers_mut().insert(
        http::header::CONTENT_TYPE,
        http::HeaderValue::from_static("application/json"),
    );
    resp
}

/// Prometheus text-exposition-format scrape target. Hand-rolled rather than
/// pulling in the `prometheus` crate: every value already lives in
/// `ServerHealth` (the same fields `health_response`'s JSON reads), so a
/// crate would only buy us a format we can produce in a dozen `format!`
/// calls. `requests_total` per backend is `ServerHealth::total_requests()` —
/// this doubles as router-core's per-backend selection count, i.e. "did P2C
/// actually spread load" is answerable straight from this endpoint.
fn metrics_response(state: &ProxyState) -> Response<BoxBody<Bytes, BoxErr>> {
    let mut out = String::new();

    out.push_str("# HELP lb_proxy_requests_total Total requests routed by this proxy.\n");
    out.push_str("# TYPE lb_proxy_requests_total counter\n");
    out.push_str(&format!("lb_proxy_requests_total {}\n", state.requests_total()));

    out.push_str("# HELP lb_proxy_backend_requests_total Requests routed to this backend (lifetime) -- also the P2C/round-robin selection count.\n");
    out.push_str("# TYPE lb_proxy_backend_requests_total counter\n");
    out.push_str("# HELP lb_proxy_backend_in_flight In-flight requests currently dispatched to this backend.\n");
    out.push_str("# TYPE lb_proxy_backend_in_flight gauge\n");
    out.push_str("# HELP lb_proxy_backend_five_xx_in_window 5xx responses observed in the trailing health window.\n");
    out.push_str("# TYPE lb_proxy_backend_five_xx_in_window gauge\n");
    out.push_str("# HELP lb_proxy_backend_error_rate Fraction of requests in the trailing window that returned 5xx.\n");
    out.push_str("# TYPE lb_proxy_backend_error_rate gauge\n");
    out.push_str("# HELP lb_proxy_backend_latency_ema_seconds Exponential moving average of backend response-head latency, the same signal router-core's risk prediction is derived from.\n");
    out.push_str("# TYPE lb_proxy_backend_latency_ema_seconds gauge\n");

    for (i, url) in state.backends().iter().enumerate() {
        let sid = ServerId(i as u64);
        let Some(health) = state.server_health(sid) else {
            continue;
        };
        let labels = format!("backend=\"{i}\",url=\"{url}\"");
        let snap = health.snapshot(state.five_xx_window);

        out.push_str(&format!(
            "lb_proxy_backend_requests_total{{{labels}}} {}\n",
            health.total_requests()
        ));
        out.push_str(&format!("lb_proxy_backend_in_flight{{{labels}}} {}\n", snap.in_flight));
        out.push_str(&format!(
            "lb_proxy_backend_five_xx_in_window{{{labels}}} {}\n",
            health.five_xx_count(state.five_xx_window)
        ));
        out.push_str(&format!(
            "lb_proxy_backend_error_rate{{{labels}}} {}\n",
            health.error_rate(state.five_xx_window)
        ));
        out.push_str(&format!(
            "lb_proxy_backend_latency_ema_seconds{{{labels}}} {}\n",
            health.latency_ema_ns() as f64 / 1_000_000_000.0
        ));
    }

    let mut resp = Response::new(box_bytes(Bytes::from(out)));
    *resp.status_mut() = StatusCode::OK;
    resp.headers_mut().insert(
        http::header::CONTENT_TYPE,
        http::HeaderValue::from_static("text/plain; version=0.0.4"),
    );
    resp
}

fn text_response(status: StatusCode, msg: &str) -> Response<BoxBody<Bytes, BoxErr>> {
    let mut resp = Response::new(box_bytes(Bytes::from(msg.to_string())));
    *resp.status_mut() = status;
    resp.headers_mut().insert(
        http::header::CONTENT_TYPE,
        http::HeaderValue::from_static("text/plain; charset=utf-8"),
    );
    resp
}

fn box_json(value: &serde_json::Value) -> BoxBody<Bytes, BoxErr> {
    box_bytes(Bytes::from(value.to_string()))
}

fn box_bytes(b: Bytes) -> BoxBody<Bytes, BoxErr> {
    Full::new(b)
        .map_err(|e: Infallible| {
            let err: BoxErr = Box::new(e);
            err
        })
        .boxed()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering as AtomicOrdering};
    use std::sync::Arc;
    use std::task::Waker;

    fn noop_cx<'a>() -> Context<'a> {
        Context::from_waker(Waker::noop())
    }

    fn counting_on_done() -> (Arc<AtomicUsize>, impl FnOnce() + Send + Sync + 'static) {
        let count = Arc::new(AtomicUsize::new(0));
        let count_cb = count.clone();
        let cb = move || {
            count_cb.fetch_add(1, AtomicOrdering::SeqCst);
        };
        (count, cb)
    }

    /// A body that yields one data frame then `Ready(None)`.
    struct OneShotBody(Option<Bytes>);
    impl Body for OneShotBody {
        type Data = Bytes;
        type Error = std::convert::Infallible;
        fn poll_frame(
            mut self: Pin<&mut Self>,
            _cx: &mut Context<'_>,
        ) -> Poll<Option<Result<Frame<Self::Data>, Self::Error>>> {
            match self.0.take() {
                Some(d) => Poll::Ready(Some(Ok(Frame::data(d)))),
                None => Poll::Ready(None),
            }
        }
        fn is_end_stream(&self) -> bool {
            self.0.is_none()
        }
    }

    /// A body whose single frame is an error (simulates a mid-stream failure
    /// from the backend connection).
    struct ErrOnceBody(bool);
    impl Body for ErrOnceBody {
        type Data = Bytes;
        type Error = &'static str;
        fn poll_frame(
            mut self: Pin<&mut Self>,
            _cx: &mut Context<'_>,
        ) -> Poll<Option<Result<Frame<Self::Data>, Self::Error>>> {
            if !self.0 {
                self.0 = true;
                Poll::Ready(Some(Err("boom")))
            } else {
                Poll::Ready(None)
            }
        }
    }

    /// A body that is never ready (simulates a client that aborts before the
    /// stream ever produces its next frame).
    struct PendingForever;
    impl Body for PendingForever {
        type Data = Bytes;
        type Error = std::convert::Infallible;
        fn poll_frame(
            self: Pin<&mut Self>,
            _cx: &mut Context<'_>,
        ) -> Poll<Option<Result<Frame<Self::Data>, Self::Error>>> {
            Poll::Pending
        }
    }

    #[test]
    fn tracked_body_fires_on_done_exactly_once_on_normal_completion() {
        let (count, cb) = counting_on_done();
        let mut body = Box::pin(TrackedBody::new(OneShotBody(Some(Bytes::from("x"))), cb));
        let mut cx = noop_cx();

        // First frame: data, not finished yet.
        assert!(matches!(body.as_mut().poll_frame(&mut cx), Poll::Ready(Some(Ok(_)))));
        assert_eq!(count.load(AtomicOrdering::SeqCst), 0, "on_done must not fire before the body ends");

        // Second frame: None => end of stream => on_done fires exactly once.
        assert!(matches!(body.as_mut().poll_frame(&mut cx), Poll::Ready(None)));
        assert_eq!(count.load(AtomicOrdering::SeqCst), 1);

        // Dropping an already-finished body must NOT fire on_done again.
        drop(body);
        assert_eq!(count.load(AtomicOrdering::SeqCst), 1, "on_done must not double-fire on drop after natural completion");
    }

    #[test]
    fn tracked_body_fires_on_done_exactly_once_on_mid_stream_error() {
        let (count, cb) = counting_on_done();
        let mut body = Box::pin(TrackedBody::new(ErrOnceBody(false), cb));
        let mut cx = noop_cx();

        assert!(matches!(body.as_mut().poll_frame(&mut cx), Poll::Ready(Some(Err(_)))));
        assert_eq!(count.load(AtomicOrdering::SeqCst), 1, "on_done must fire on a Ready(Some(Err(_))) frame");

        drop(body);
        assert_eq!(count.load(AtomicOrdering::SeqCst), 1, "on_done must not double-fire on drop after an error frame");
    }

    /// This is the "client aborts before the streamed response body is fully
    /// drained" case: the body is dropped while still mid-stream (never
    /// polled to completion, no error frame observed) — only `Drop` can
    /// release the in-flight slot here, and it must do so exactly once.
    #[test]
    fn tracked_body_fires_on_done_exactly_once_when_dropped_mid_stream() {
        let (count, cb) = counting_on_done();
        let mut body = Box::pin(TrackedBody::new(OneShotBody(Some(Bytes::from("x"))), cb));
        let mut cx = noop_cx();

        // Consume the one data frame but never reach Ready(None).
        assert!(matches!(body.as_mut().poll_frame(&mut cx), Poll::Ready(Some(Ok(_)))));
        assert_eq!(count.load(AtomicOrdering::SeqCst), 0);

        drop(body); // simulates the client connection dying mid-stream
        assert_eq!(count.load(AtomicOrdering::SeqCst), 1, "Drop must release the in-flight slot even if the stream never reached its end");
    }

    /// Dropped before a single frame was ever produced (e.g. client
    /// disconnects while the response is still buffering) — still exactly
    /// one release.
    #[test]
    fn tracked_body_fires_on_done_exactly_once_when_dropped_before_any_poll_progress() {
        let (count, cb) = counting_on_done();
        let mut body = Box::pin(TrackedBody::new(PendingForever, cb));
        let mut cx = noop_cx();

        assert!(matches!(body.as_mut().poll_frame(&mut cx), Poll::Pending));
        assert_eq!(count.load(AtomicOrdering::SeqCst), 0);

        drop(body);
        assert_eq!(count.load(AtomicOrdering::SeqCst), 1);
    }

    #[test]
    fn strip_hop_by_hop_removes_every_listed_header_and_nothing_else() {
        let mut headers = HeaderMap::new();
        for name in [
            "connection",
            "keep-alive",
            "proxy-authenticate",
            "proxy-authorization",
            "te",
            "trailer",
            "transfer-encoding",
            "upgrade",
            "host",
            "content-length",
        ] {
            headers.insert(HeaderName::from_static(name), "x".parse().unwrap());
        }
        headers.insert(http::header::CONTENT_TYPE, "text/plain".parse().unwrap());
        headers.insert(HeaderName::from_static("x-custom"), "keep-me".parse().unwrap());

        strip_hop_by_hop(&mut headers);

        for name in [
            "connection",
            "keep-alive",
            "proxy-authenticate",
            "proxy-authorization",
            "te",
            "trailer",
            "transfer-encoding",
            "upgrade",
            "host",
            "content-length",
        ] {
            assert!(
                headers.get(name).is_none(),
                "hop-by-hop header `{name}` should have been stripped but is still present"
            );
        }
        assert_eq!(headers.get(http::header::CONTENT_TYPE).unwrap(), "text/plain");
        assert_eq!(headers.get("x-custom").unwrap(), "keep-me");
        assert_eq!(headers.len(), 2, "only the two non-hop-by-hop headers should remain");
    }

    /// The trust boundary in miniature: whatever the client claims in
    /// `X-Forwarded-For` (single forged value or a whole forged chain) is
    /// replaced by the actual peer IP of the accepted connection — the
    /// client's claim must never survive to be forwarded to a backend.
    #[test]
    fn set_forwarded_for_overwrites_client_spoofed_value_with_real_peer_ip() {
        for spoofed in ["203.0.113.7", "203.0.113.7, 10.0.0.1"] {
            let mut headers = HeaderMap::new();
            headers.insert(
                HeaderName::from_static("x-forwarded-for"),
                spoofed.parse().unwrap(),
            );
            headers.insert(
                HeaderName::from_static("x-custom"),
                "keep-me".parse().unwrap(),
            );

            set_forwarded_for(&mut headers, SocketAddr::from(([192, 168, 1, 20], 54321)));

            let xff = headers
                .get(HeaderName::from_static("x-forwarded-for"))
                .unwrap()
                .to_str()
                .unwrap();
            assert_eq!(
                xff, "192.168.1.20",
                "spoofed `{spoofed}` must be overwritten with the real peer IP, got `{xff}`"
            );
            assert_eq!(headers.len(), 2, "no other headers may be disturbed");
            assert_eq!(headers.get("x-custom").unwrap(), "keep-me");
        }
    }
}