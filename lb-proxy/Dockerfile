# syntax=docker/dockerfile:1

# NOTE ON BUILD CONTEXT: lb-proxy's Cargo.toml depends on the sibling crate
# (`router-core = { path = "../router-core" }`), so this Dockerfile must be
# built with the REPO ROOT as the build context:
#
#   docker build -f lb-proxy/Dockerfile -t booking-lb-proxy:local .
#
# `docker build lb-proxy/` (context = lb-proxy/) cannot work — Docker contexts
# can't reach ../router-core.

# --- Build stage ---
FROM rust:1-slim AS build
WORKDIR /src

COPY lb-proxy/Cargo.toml lb-proxy/Cargo.lock ./lb-proxy/
COPY router-core ./router-core
COPY lb-proxy/src ./lb-proxy/src

RUN cargo build --release --manifest-path lb-proxy/Cargo.toml

# --- Runtime stage: minimal slim base, non-root user ---
FROM debian:bookworm-slim AS runtime

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd -r lbproxy && useradd -r -g lbproxy lbproxy

COPY --from=build /src/lb-proxy/target/release/lb-proxy /usr/local/bin/lb-proxy

USER lbproxy
EXPOSE 8080
CMD ["lb-proxy"]