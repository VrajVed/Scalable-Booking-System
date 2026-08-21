import client from "prom-client";

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
