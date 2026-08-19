//! Integration tests: real sockets, in-process fake backends, real proxy.
//!
//! Each test spawns one or two fake backends (tiny hyper http1 servers) and
//! a `lb-proxy` instance pointed at them, then hits the proxy with a real
//! HTTP/1.1 client and asserts on routing behavior.

use std::convert::Infallible;
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

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
        proxy::run(listener, st).await;
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