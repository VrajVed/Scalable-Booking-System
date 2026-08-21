import type { FastifyInstance } from "fastify";
import client from "prom-client";

declare module "fastify" {
  interface FastifyRequest {
    // Set in index.ts's onRequest hook, read by both its onResponse hook and
    // its request.raw 'close' listener so http_requests_in_flight is
    // decremented exactly once per request regardless of which one runs
    // first (see index.ts for why both exist).
    inFlightAccountedFor?: boolean;
  }
}

// Single shared registry for every metric in the process, scraped via the
// /metrics route in index.ts. collectDefaultMetrics adds Node process
// metrics for free (CPU, RSS/heap, event loop lag, GC pauses, active
// handles) -- the same signals CLAUDE.md's roadmap calls out under
// "CPU/memory on the backend".
export const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry });

export const httpRequestDuration = new client.Histogram({
  name: "http_request_duration_seconds",
  help: "HTTP request duration in seconds, labeled by route (not raw URL, to keep cardinality bounded)",
  labelNames: ["method", "route", "status_code"] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [registry],
});

export const httpRequestsInFlight = new client.Gauge({
  name: "http_requests_in_flight",
  help: "HTTP requests currently being processed",
  registers: [registry],
});

// Mirrors the existing isCdcConsumerConnected()/isProducerConnected()
// booleans already surfaced on /health, as a scrapeable time series instead
// of a point-in-time check.
export const cdcConsumerConnected = new client.Gauge({
  name: "cdc_consumer_connected",
  help: "1 if the Debezium CDC Kafka consumer is connected, 0 otherwise",
  registers: [registry],
});

export const kafkaProducerConnected = new client.Gauge({
  name: "kafka_producer_connected",
  help: "1 if the Kafka producer is connected, 0 otherwise",
  registers: [registry],
});

export const bookingEventsPublishedTotal = new client.Counter({
  name: "booking_events_published_total",
  help: "Booking domain events published to Kafka, by event type",
  labelNames: ["type"] as const,
  registers: [registry],
});

export const holdExpiryJobsTotal = new client.Counter({
  name: "hold_expiry_jobs_total",
  help: "Processed hold-expiry queue jobs, by outcome",
  labelNames: ["outcome"] as const,
  registers: [registry],
});

// Registers the onRequest/onResponse pair that drives httpRequestsInFlight
// and httpRequestDuration. Extracted out of index.ts (rather than left as
// inline closures there) so a test can register the same real hooks on a
// throwaway Fastify instance instead of re-implementing the logic and
// risking it drifting from what actually runs in production.
export function registerHttpMetricsHooks(app: FastifyInstance): void {
  app.addHook("onRequest", async (request) => {
    httpRequestsInFlight.inc();
    // Fastify's onResponse only fires on reply.raw's 'finish'/'error' events
    // (fastify/lib/reply.js's setupResponseListeners) -- if the client
    // aborts before the response finishes writing, neither fires and
    // onResponse never runs, permanently leaking this gauge upward.
    // request.raw's 'close' event covers that gap, but it also fires on
    // ordinary completed requests (after 'finish'), so both paths share the
    // accountedFor flag to decrement exactly once regardless of which one
    // wins -- mirrors lb-proxy's TrackedBody exactly-once-release pattern
    // (lb-proxy/src/proxy.rs).
    request.inFlightAccountedFor = false;
    request.raw.once("close", () => {
      if (!request.inFlightAccountedFor) {
        request.inFlightAccountedFor = true;
        httpRequestsInFlight.dec();
      }
    });
  });

  app.addHook("onResponse", async (request, reply) => {
    if (!request.inFlightAccountedFor) {
      request.inFlightAccountedFor = true;
      httpRequestsInFlight.dec();
    }
    // request.routeOptions.url is the declared route pattern (e.g.
    // "/bookings/reserve"), not the raw URL -- keeps label cardinality
    // bounded even if this app grows path params later. Requests that never
    // matched a route (404s, probes) fall back to a single "unmatched"
    // bucket instead of one time series per garbage path.
    const route = request.routeOptions?.url ?? "unmatched";
    httpRequestDuration.observe(
      { method: request.method, route, status_code: reply.statusCode },
      reply.elapsedTime / 1000,
    );
  });
}
