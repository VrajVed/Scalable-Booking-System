//! Integration tests: real sockets, in-process fake backends, real proxy.
//!
//! Each test spawns one or two fake backends (tiny hyper http1 servers) and
//! a `lb-proxy` instance pointed at them, then hits the proxy with a real
//! HTTP/1.1 client and asserts on routing behavior.

use std::convert::Infallible;
use std::future::Future;
use std::io::Write;
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use bytes::Bytes;
use http::{Method, Request, Response, StatusCode};
use http_body_util::{BodyExt, Full};
use hyper::body::Incoming;
use hyper::client::conn::http1;
use hyper::service::service_fn;
use hyper_util::rt::TokioIo;
use tokio::net::{TcpListener, TcpStream};

use crate::config::Config;
use crate::proxy::{self, ProxyState};

type BackendHandler = Arc<
    dyn Fn(Request<Incoming>) -> Pin<Box<dyn Future<Output = Response<Full<Bytes>>> + Send>>
        + Send
        + Sync,
>;

/// Spawn a fake backend. `handler` decides the response for each request.
/// Returns the listen address and a counter of received requests.
async fn spawn_backend(handler: BackendHandler) -> (std::net::SocketAddr, Arc<AtomicU64>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let counter = Arc::new(AtomicU64::new(0));

    let counter_loop = counter.clone();
    tokio::spawn(async move {
        loop {
            let Ok((stream, _)) = listener.accept().await else {
                break;
            };
            let io = TokioIo::new(stream);
            let handler = handler.clone();
            let counter = counter_loop.clone();
            let svc = service_fn(move |req: Request<Incoming>| {
                let handler = handler.clone();
                let counter = counter.clone();
                async move {
                    counter.fetch_add(1, Ordering::Relaxed);
                    let resp = handler(req).await;
                    Ok::<_, Infallible>(resp)
                }
            });
            tokio::spawn(async move {
                let _ = hyper::server::conn::http1::Builder::new()
                    .serve_connection(io, svc)
                    .await;
            });
        }
    });

    (addr, counter)
}

fn ok_handler(tag: &'static str) -> BackendHandler {
    Arc::new(move |_req| {
        Box::pin(async move {
            Response::builder()
                .status(200)
                .body(Full::new(Bytes::from(format!("backend:{tag}"))))
                .unwrap()
        })
    })
}

fn status_handler(code: u16) -> BackendHandler {
    Arc::new(move |_req| {
        Box::pin(async move {
            Response::builder()
                .status(code)
                .body(Full::new(Bytes::from(format!("status:{code}"))))
                .unwrap()
        })
    })
}

/// Like `ok_handler` but sleeps `delay` before responding — used to keep a
/// request in flight long enough for a client to abort mid-wait.
fn delayed_ok_handler(tag: &'static str, delay: Duration) -> BackendHandler {
    Arc::new(move |_req| {
        Box::pin(async move {
            tokio::time::sleep(delay).await;
            Response::builder()
                .status(200)
                .body(Full::new(Bytes::from(format!("backend:{tag}"))))
                .unwrap()
        })
    })
}

/// Reports every header name it received (lowercased) plus the `Host`
/// header's value, so tests can assert on exact absence/presence rather
/// than just spot-checking a couple of survivors.
fn header_report_handler() -> BackendHandler {
    Arc::new(|req: Request<Incoming>| {
        Box::pin(async move {
            let host = req
                .headers()
                .get(http::header::HOST)
                .and_then(|v| v.to_str().ok())
                .unwrap_or("")
                .to_string();
            let names: Vec<String> = req
                .headers()
                .keys()
                .map(|n| n.as_str().to_string())
                .collect();
            let payload = serde_json::json!({ "host": host, "header_names": names });
            Response::builder()
                .status(200)
                .header("content-type", "application/json")
                .body(Full::new(Bytes::from(payload.to_string())))
                .unwrap()
        })
    })
}

/// Reports the exact `X-Forwarded-For` value it received, so the trust
/// boundary tests can assert on the precise forwarded value (not just its
/// presence/absence).
fn xff_report_handler() -> BackendHandler {
    Arc::new(|req: Request<Incoming>| {
        Box::pin(async move {
            let xff = req
                .headers()
                .get("x-forwarded-for")
                .and_then(|v| v.to_str().ok())
                .unwrap_or("")
                .to_string();
            let payload = serde_json::json!({ "xff": xff });
            Response::builder()
                .status(200)
                .header("content-type", "application/json")
                .body(Full::new(Bytes::from(payload.to_string())))
                .unwrap()
        })
    })
}

fn echo_handler() -> BackendHandler {
    Arc::new(|req: Request<Incoming>| {
        Box::pin(async move {
            let method = req.method().to_string();
            let path = req.uri().path().to_string();
            let query = req
                .uri()
                .query()
                .map(|q| format!("?{q}"))
                .unwrap_or_default();
            let custom = req
                .headers()
                .get("x-custom")
                .and_then(|v| v.to_str().ok())
                .unwrap_or("")
                .to_string();
            let body = req.into_body().collect().await.unwrap().to_bytes();
            let payload = serde_json::json!({
                "method": method,
                "path": format!("{path}{query}"),
                "x-custom": custom,
                "body": String::from_utf8_lossy(&body),
            });
            Response::builder()
                .status(200)
                .header("content-type", "application/json")
                .body(Full::new(Bytes::from(payload.to_string())))
                .unwrap()
        })
    })
}

async fn spawn_proxy(cfg: Config) -> (std::net::SocketAddr, Arc<ProxyState>) {
    let state = ProxyState::new(cfg);
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let st = state.clone();
    tokio::spawn(async move {
        proxy::run_until(listener, st, std::future::pending()).await;
    });
    (addr, state)
}

/// Fire `n` sequential requests over a single keep-alive connection to the proxy.
async fn run_requests(proxy: std::net::SocketAddr, n: usize, path: &str) {
    let stream = TcpStream::connect(proxy).await.unwrap();
    let (mut sender, conn) = http1::Builder::new()
        .handshake(TokioIo::new(stream))
        .await
        .unwrap();
    tokio::spawn(async move {
        let _ = conn.await;
    });

    for _ in 0..n {
        let req = Request::builder()
            .method(Method::GET)
            .uri(path)
            .body(Full::new(Bytes::new()))
            .unwrap();
        let resp = sender.send_request(req).await.unwrap();
        let (_parts, body) = resp.into_parts();
        body.collect().await.unwrap();
    }
}

/// Send a single request through the proxy and return (status, body, headers).
async fn one_request(
    proxy: std::net::SocketAddr,
    method: Method,
    path: &str,
    body: &[u8],
    headers: &[(&str, &str)],
) -> (StatusCode, String) {
    let stream = TcpStream::connect(proxy).await.unwrap();
    let (mut sender, conn) = http1::Builder::new()
        .handshake(TokioIo::new(stream))
        .await
        .unwrap();
    tokio::spawn(async move {
        let _ = conn.await;
    });

    let mut builder = Request::builder().method(method).uri(path);
    for (k, v) in headers {
        builder = builder.header(*k, *v);
    }
    let req = builder
        .body(Full::new(Bytes::copy_from_slice(body)))
        .unwrap();
    let resp = sender.send_request(req).await.unwrap();
    let (parts, body) = resp.into_parts();
    let bytes = body.collect().await.unwrap().to_bytes();
    (parts.status, String::from_utf8_lossy(&bytes).to_string())
}

/// Connect to the proxy, write a complete HTTP/1.1 request, then drop the
/// socket without reading any response. Simulates a client that vanishes
/// mid-request (a plain drop sends a FIN; that's enough for the proxy's
/// read/write side to observe the peer is gone before any response was
/// consumed — `set_linger`/RST is gated behind an unstable std feature on
/// this toolchain, and a graceful FIN is sufficient to exercise the same
/// cancellation path).
async fn send_and_abort(proxy: std::net::SocketAddr, path: &str) {
    let stream = TcpStream::connect(proxy).await.unwrap();
    let std_stream = stream.into_std().unwrap();
    std_stream.set_nonblocking(false).unwrap();
    let req = format!("GET {path} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n");
    {
        let mut w = &std_stream;
        w.write_all(req.as_bytes()).unwrap();
    }
    drop(std_stream);
}

/// Fire `n` requests at the proxy truly concurrently (separate connections,
/// separate tasks) rather than serialized over one keep-alive connection.
async fn concurrent_requests(proxy: std::net::SocketAddr, n: usize, path: &str) {
    let path = path.to_string();
    let mut handles = Vec::with_capacity(n);
    for _ in 0..n {
        let path = path.clone();
        handles.push(tokio::spawn(async move {
            one_request(proxy, Method::GET, &path, b"", &[]).await;
        }));
    }
    for h in handles {
        h.await.unwrap();
    }
}

#[tokio::test]
async fn proxies_its_own_health_endpoint() {
    let (b_addr, _) = spawn_backend(ok_handler("B")).await;
    let cfg = Config::with_backends(vec![format!("http://{b_addr}")]);
    let (proxy, _state) = spawn_proxy(cfg).await;

    let (status, body) = one_request(proxy, Method::GET, "/health", b"", &[]).await;
    assert_eq!(status, 200);
    assert!(body.contains("\"status\":\"ok\""), "health body: {body}");
    assert!(body.contains(&format!("http://{b_addr}")), "health body: {body}");
}

#[tokio::test]
async fn distributes_across_healthy_backends() {
    let (a_addr, a_count) = spawn_backend(ok_handler("A")).await;
    let (b_addr, b_count) = spawn_backend(ok_handler("B")).await;

    let cfg = Config::with_backends(vec![
        format!("http://{a_addr}"),
        format!("http://{b_addr}"),
    ]);
    let (proxy, state) = spawn_proxy(cfg).await;

    run_requests(proxy, 200, "/ping").await;

    let a = a_count.load(Ordering::Relaxed);
    let b = b_count.load(Ordering::Relaxed);
    assert_eq!(state.requests_total(), 200, "proxy counter should match requests");
    assert_eq!(a + b, 200, "all requests should reach a backend");
    assert!(
        a >= 60 && b >= 60,
        "both healthy backends should get a meaningful share: a={a} b={b}"
    );
}

#[tokio::test]
async fn shifts_traffic_away_from_unhealthy_backend() {
    // Three backends: A always fails, B and C are healthy. A 3-server pool
    // guarantees the failing backend actually receives (and fails) traffic
    // before the health feedback diverts it — with only 2 servers the very
    // first 500 already tilts the scoreboard and A may never accumulate enough
    // failures to make the test meaningful.
    let (a_addr, a_count) = spawn_backend(status_handler(500)).await;
    let (b_addr, b_count) = spawn_backend(ok_handler("B")).await;
    let (c_addr, c_count) = spawn_backend(ok_handler("C")).await;

    let cfg = Config::with_backends(vec![
        format!("http://{a_addr}"),
        format!("http://{b_addr}"),
        format!("http://{c_addr}"),
    ]);
    let (proxy, _state) = spawn_proxy(cfg).await;

    // Wave 1: enough traffic for A to fail repeatedly and be flagged.
    run_requests(proxy, 60, "/ping").await;
    let a1 = a_count.load(Ordering::Relaxed);
    let b1 = b_count.load(Ordering::Relaxed);
    let c1 = c_count.load(Ordering::Relaxed);

    // Wave 2: routing should now overwhelmingly favor the healthy backends.
    run_requests(proxy, 200, "/ping").await;
    let a2 = a_count.load(Ordering::Relaxed);
    let b2 = b_count.load(Ordering::Relaxed);
    let c2 = c_count.load(Ordering::Relaxed);

    assert_eq!(a1 + b1 + c1, 60, "wave 1: all requests reach a backend");
    assert_eq!(a2 + b2 + c2, 260, "wave 2: all requests reach a backend");
    assert!(
        a1 >= 6,
        "unhealthy backend must receive traffic before being detected, got {a1}"
    );
    assert!(
        a2 - a1 <= 5,
        "traffic should shift away from the failing backend: A {a1} -> {a2}"
    );
    assert!(
        (b2 - b1) + (c2 - c1) >= 195,
        "healthy backends should take ~all wave-2 traffic: B {b1}->{b2}, C {c1}->{c2}"
    );
}

#[tokio::test]
async fn forwards_method_headers_and_body() {
    let (b_addr, _) = spawn_backend(echo_handler()).await;
    let cfg = Config::with_backends(vec![format!("http://{b_addr}")]);
    let (proxy, _state) = spawn_proxy(cfg).await;

    let (status, body) = one_request(
        proxy,
        Method::POST,
        "/api/bookings?x=1",
        b"reserve row A seat 12",
        &[("content-type", "text/plain"), ("x-custom", "yes")],
    )
    .await;

    assert_eq!(status, 200);
    let parsed: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(parsed["method"], "POST");
    assert_eq!(parsed["path"], "/api/bookings?x=1");
    assert_eq!(parsed["x-custom"], "yes");
    assert_eq!(parsed["body"], "reserve row A seat 12");
}

/// Adversarial in-flight-accounting check: what happens when the client
/// vanishes (hard RST) while `handle()` is still `.await`ing the backend
/// response, i.e. before either the `Ok` or `Err` arm of the match in
/// `handle()` has run? `health.decrement()` only lives inside those two
/// arms — if the whole `handle()` future gets dropped/cancelled out from
/// under the pending `state.client.request(out_req).await` (which is a
/// real risk: hyper can tear down a server connection's in-flight service
/// future when it detects the peer is gone), nothing ever decrements
/// in_flight for that backend, and the counter leaks upward forever.
#[tokio::test]
async fn in_flight_is_released_even_when_client_aborts_before_backend_responds() {
    let backend_delay = Duration::from_millis(300);
    let (b_addr, _count) = spawn_backend(delayed_ok_handler("B", backend_delay)).await;
    let cfg = Config::with_backends(vec![format!("http://{b_addr}")]);
    let (proxy, _state) = spawn_proxy(cfg).await;

    // Abort several client connections while the (single) backend is still
    // "thinking". With one backend every request routes to it, so a leak
    // accumulates visibly instead of being diluted across a pool.
    for _ in 0..3 {
        send_and_abort(proxy, "/ping").await;
    }

    // Comfortably past the backend's delay, so any in-progress request
    // (cancelled or not) has had every chance to resolve one way or another.
    tokio::time::sleep(backend_delay * 4).await;

    let (_status, body) = one_request(proxy, Method::GET, "/health", b"", &[]).await;
    let parsed: serde_json::Value = serde_json::from_str(&body).unwrap();
    let in_flight = parsed["backends"][0]["in_flight"].as_u64().unwrap();
    assert_eq!(
        in_flight, 0,
        "in_flight leaked after client aborts: {body} \
         (health.decrement() was never reached for one or more aborted requests)"
    );
}

/// A single backend with nothing listening on it: the proxy must not panic,
/// must keep responding (with 502s), and must reflect the failures in its
/// health signals rather than staying neutral forever or leaking in_flight.
#[tokio::test]
async fn unreachable_backend_returns_502_and_updates_health_without_leaking() {
    // Bind then immediately drop, to grab a port nothing is listening on.
    let addr = {
        let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
        l.local_addr().unwrap()
    };
    let cfg = Config::with_backends(vec![format!("http://{addr}")]);
    let (proxy, _state) = spawn_proxy(cfg).await;

    for _ in 0..20 {
        let (status, body) = one_request(proxy, Method::GET, "/ping", b"", &[]).await;
        assert_eq!(status, StatusCode::BAD_GATEWAY, "unreachable backend must yield 502, got body: {body}");
    }

    let (_status, body) = one_request(proxy, Method::GET, "/health", b"", &[]).await;
    let parsed: serde_json::Value = serde_json::from_str(&body).unwrap();
    let in_flight = parsed["backends"][0]["in_flight"].as_u64().unwrap();
    let five_xx = parsed["backends"][0]["five_xx_in_window"].as_u64().unwrap();
    assert_eq!(in_flight, 0, "in_flight must not leak on outright connection failures: {body}");
    assert!(
        five_xx >= 20,
        "every connection failure should register as a 5xx-class health event: {body}"
    );
}

/// `/health` is matched by exact path only. A query string must not defeat
/// the match (the proxy's own readiness probe must still be intercepted,
/// never forwarded to a backend), while a trailing slash is a *different*
/// path and should behave like any other proxied request.
#[tokio::test]
async fn health_route_match_is_path_exact_but_ignores_query_string() {
    let (b_addr, b_count) = spawn_backend(ok_handler("B")).await;
    let cfg = Config::with_backends(vec![format!("http://{b_addr}")]);
    let (proxy, _state) = spawn_proxy(cfg).await;

    // Query string must not escape interception.
    let (status, body) = one_request(proxy, Method::GET, "/health?foo=1", b"", &[]).await;
    assert_eq!(status, 200);
    assert!(body.contains("\"status\":\"ok\""), "body: {body}");
    assert_eq!(b_count.load(Ordering::Relaxed), 0, "/health?foo=1 must not reach the backend");

    // Trailing slash is a distinct path: NOT intercepted, gets proxied.
    let (status, body) = one_request(proxy, Method::GET, "/health/", b"", &[]).await;
    assert_eq!(status, 200);
    assert!(!body.contains("\"status\":\"ok\""), "body: {body}");
    assert_eq!(
        b_count.load(Ordering::Relaxed),
        1,
        "/health/ is a different path from /health and should be proxied to a backend"
    );
}

/// Hop-by-hop headers must be fully stripped outbound, and the outbound
/// `Host` header must be the backend's own authority — never a value the
/// client supplied (which would otherwise leak the client-facing Host, or
/// let a client spoof the backend's view of its own identity).
#[tokio::test]
async fn strips_hop_by_hop_headers_and_rewrites_host_to_backend_authority() {
    let (b_addr, _) = spawn_backend(header_report_handler()).await;
    let cfg = Config::with_backends(vec![format!("http://{b_addr}")]);
    let (proxy, _state) = spawn_proxy(cfg).await;

    let (status, body) = one_request(
        proxy,
        Method::GET,
        "/ping",
        b"",
        &[
            ("host", "evil-client-supplied-host.example:9999"),
            ("connection", "keep-alive"),
            ("keep-alive", "timeout=5"),
            ("te", "trailers"),
            ("trailer", "x-checksum"),
            ("transfer-encoding", "chunked"),
            ("upgrade", "websocket"),
            ("x-custom", "survives"),
        ],
    )
    .await;

    assert_eq!(status, 200);
    let parsed: serde_json::Value = serde_json::from_str(&body).unwrap();
    let host = parsed["host"].as_str().unwrap();
    assert_eq!(
        host,
        b_addr.to_string(),
        "outbound Host must be rewritten to the backend's own authority, not leak the client-supplied Host"
    );

    let names: Vec<String> = parsed["header_names"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap().to_lowercase())
        .collect();
    for hop in [
        "connection",
        "keep-alive",
        "te",
        "trailer",
        // Note: `transfer-encoding` and `upgrade` are deliberately NOT
        // asserted absent here — the outbound *client body* is a GET with
        // no body, but the raw request line we send still includes these
        // headers, and strip_hop_by_hop must remove them regardless of
        // method/body shape.
        "transfer-encoding",
        "upgrade",
    ] {
        assert!(!names.contains(&hop.to_string()), "hop-by-hop header `{hop}` leaked to backend: {names:?}");
    }
    assert!(names.contains(&"x-custom".to_string()), "non-hop-by-hop header must survive: {names:?}");
}

/// The rate-limiter trust boundary: lb-proxy is the only hop between the
/// internet and the backends, and the backend derives the client IP from
/// `X-Forwarded-For` trusting exactly this one hop. So whatever the client
/// claims in `X-Forwarded-For` (single forged value, a forged multi-hop
/// chain, or nothing at all) must be replaced with the actual TCP peer
/// address of the connection the proxy accepted — a client must neither be
/// able to rotate the header per request to dodge rate limiting nor spoof a
/// victim's IP into it.
#[tokio::test]
async fn overwrites_client_spoofed_x_forwarded_for_with_the_real_peer_ip() {
    let (b_addr, _) = spawn_backend(xff_report_handler()).await;
    let cfg = Config::with_backends(vec![format!("http://{b_addr}")]);
    let (proxy, _state) = spawn_proxy(cfg).await;
    // Tests connect from the loopback, so the real peer the proxy sees is
    // 127.0.0.1. This is the value the backend must receive — verbatim.
    let real_peer = "127.0.0.1";

    for spoofed in ["203.0.113.7", "203.0.113.7, 10.0.0.1", "203.0.113.7, 10.0.0.1, 192.0.2.7"] {
        let (status, body) = one_request(
            proxy,
            Method::GET,
            "/ping",
            b"",
            &[("x-forwarded-for", spoofed)],
        )
        .await;
        assert_eq!(status, 200);
        let parsed: serde_json::Value = serde_json::from_str(&body).unwrap();
        let xff = parsed["xff"].as_str().unwrap();
        assert_eq!(
            xff, real_peer,
            "backend must see the proxy's real TCP peer ({real_peer}), never the client-supplied `{spoofed}`; got `{xff}`"
        );
    }

    // A request that sent no X-Forwarded-For at all still gets the peer
    // written, so the backend can always compute a client identity.
    let (status, body) = one_request(proxy, Method::GET, "/ping", b"", &[]).await;
    assert_eq!(status, 200);
    let parsed: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(
        parsed["xff"].as_str().unwrap(),
        real_peer,
        "X-Forwarded-For must be written even when the client sent none"
    );
}

/// P2C with the `Mutex<Router>` under real concurrent load: many tasks
/// hitting `choose_server` at once must not deadlock or panic, and the
/// resulting distribution across equally-healthy backends must not
/// degenerate to "always pick the same server".
#[tokio::test]
async fn concurrent_load_does_not_deadlock_and_distributes_across_backends() {
    let (a_addr, a_count) = spawn_backend(ok_handler("A")).await;
    let (b_addr, b_count) = spawn_backend(ok_handler("B")).await;
    let (c_addr, c_count) = spawn_backend(ok_handler("C")).await;

    let cfg = Config::with_backends(vec![
        format!("http://{a_addr}"),
        format!("http://{b_addr}"),
        format!("http://{c_addr}"),
    ]);
    let (proxy, state) = spawn_proxy(cfg).await;

    concurrent_requests(proxy, 300, "/ping").await;

    let a = a_count.load(Ordering::Relaxed);
    let b = b_count.load(Ordering::Relaxed);
    let c = c_count.load(Ordering::Relaxed);
    assert_eq!(state.requests_total(), 300, "no request should be lost under concurrent load");
    assert_eq!(a + b + c, 300, "every request must reach exactly one backend");
    assert!(
        a > 0 && b > 0 && c > 0,
        "P2C must not degenerate to always picking one server under concurrency: a={a} b={b} c={c}"
    );
}

/// Graceful shutdown must not cut off a request that was already in flight
/// when the shutdown signal fires. This is the Kubernetes SIGTERM scenario:
/// the pod keeps serving whatever it already accepted while draining, it
/// doesn't just die and reset the connection out from under the client.
#[tokio::test]
async fn run_until_drains_in_flight_request_across_shutdown_signal() {
    let backend_delay = Duration::from_millis(200);
    let (b_addr, _count) = spawn_backend(delayed_ok_handler("B", backend_delay)).await;
    let cfg = Config::with_backends(vec![format!("http://{b_addr}")]);
    let state = ProxyState::new(cfg);

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();

    let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel::<()>();
    let run_handle = tokio::spawn(async move {
        proxy::run_until(listener, state, async move {
            let _ = shutdown_rx.await;
        })
        .await;
    });

    // Kick off a request that will still be waiting on the (slow) backend
    // when we signal shutdown below.
    let in_flight = tokio::spawn(async move { one_request(addr, Method::GET, "/ping", b"", &[]).await });

    // Give the request time to be accepted by the proxy and dispatched to
    // the backend before we pull the shutdown trigger.
    tokio::time::sleep(Duration::from_millis(50)).await;
    let _ = shutdown_tx.send(());

    // Load-bearing ordering assertion: `run_until` must still be *waiting*
    // on the in-flight connection at this point (the backend hasn't
    // responded yet — `backend_delay` is 200ms and we're only ~70ms past
    // shutdown). If `run_until` returned as soon as `shutdown` resolved
    // (the old crash-on-SIGTERM behavior, which merely dropping the
    // listener would already exhibit), this would spuriously succeed —
    // it's the fact that it's still pending here that proves the drain
    // actually blocks on the open connection rather than the connection
    // task just happening to survive in the background regardless of what
    // `run_until` does.
    let mut run_handle = run_handle;
    match tokio::time::timeout(Duration::from_millis(20), &mut run_handle).await {
        Err(_) => {} // still running — expected
        Ok(res) => panic!(
            "run_until returned before the in-flight request finished — it isn't actually draining: {res:?}"
        ),
    }

    // The in-flight request must still complete successfully — shutdown
    // must not abort it.
    let (status, body) = tokio::time::timeout(Duration::from_secs(2), in_flight)
        .await
        .expect("in-flight request must not be aborted by shutdown")
        .unwrap();
    assert_eq!(status, StatusCode::OK, "in-flight request should complete normally despite shutdown: {body}");

    // And `run_until` itself must return promptly once draining is done
    // (well under DRAIN_TIMEOUT, since there's nothing left in flight).
    tokio::time::timeout(Duration::from_secs(2), run_handle)
        .await
        .expect("run_until must return once in-flight connections have drained")
        .unwrap();
}

/// Once `run_until`'s shutdown future resolves, the listener must stop
/// accepting brand-new connections — a shutting-down pod shouldn't keep
/// taking on fresh work while it drains.
#[tokio::test]
async fn run_until_stops_accepting_new_connections_after_shutdown() {
    let (b_addr, _count) = spawn_backend(ok_handler("B")).await;
    let cfg = Config::with_backends(vec![format!("http://{b_addr}")]);
    let state = ProxyState::new(cfg);

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();

    let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel::<()>();
    let run_handle = tokio::spawn(async move {
        proxy::run_until(listener, state, async move {
            let _ = shutdown_rx.await;
        })
        .await;
    });

    // Sanity: the proxy is up and serving before shutdown.
    let (status, _body) = one_request(addr, Method::GET, "/ping", b"", &[]).await;
    assert_eq!(status, StatusCode::OK);

    let _ = shutdown_tx.send(());
    tokio::time::timeout(Duration::from_secs(2), run_handle)
        .await
        .expect("run_until must return after shutdown with nothing in flight")
        .unwrap();

    // The listener is gone once `run_until` has returned; a fresh
    // connection attempt must fail rather than being served.
    assert!(
        TcpStream::connect(addr).await.is_err(),
        "proxy must stop accepting connections once graceful shutdown has completed"
    );
}