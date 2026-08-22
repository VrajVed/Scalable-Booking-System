import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "staging", "production"]).default("development"),
  PORT: z.coerce.number().default(3000),

  DATABASE_URL: z.url(),
  REDIS_URL: z.url(),

  // How long a seat reservation stays 'held' before the hold-expiry worker
  // reclaims it if the booking hasn't been confirmed. Overridable so tests
  // and live verification can use a short hold instead of waiting out the
  // real production window.
  HOLD_DURATION_MS: z.coerce.number().int().positive().default(5 * 60 * 1000),

  // Trust boundary (ticket 0002): addresses (IPs, CIDRs, or the named
  // ranges "loopback"/"linklocal"/"uniquelocal") of the exactly one trusted
  // reverse-proxy hop — lb-proxy — that sits between the internet and this
  // backend. Fastify derives request.ip from X-Forwarded-For only when the
  // direct TCP peer matches one of these; anything else is keyed on the raw
  // socket address, so a client can never supply its own rate-limit
  // identity. In-cluster the peer is the lb-proxy pod (k8s pod CIDR,
  // 10.244.0.0/16 for the kind cluster); local dev is loopback.
  TRUST_PROXY_ADDRESSES: z.string().default("loopback"),

  // Overridable so a load test can raise the ceiling for a run (e.g.
  // RATE_LIMIT_MAX_REQUESTS=1000000) without changing the production
  // default of 100 requests / 60s per client.
  RATE_LIMIT_MAX_REQUESTS: z.coerce.number().int().positive().default(100),
  RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().positive().default(60),

  KAFKA_BROKERS: z
    .string()
    .min(1)
    .transform((v) =>
      v
        .split(",")
        .map((broker) => broker.trim())
        .filter((broker) => broker.length > 0),
    )
    .refine((brokers) => brokers.length > 0, {
      message: "KAFKA_BROKERS must contain at least one non-empty broker (got only commas/whitespace)",
    }),
  KAFKA_CLIENT_ID: z.string().default("booking-system-backend"),
  KAFKA_CDC_GROUP_ID: z.string().default("booking-system-cdc-consumer"),
  KAFKA_CDC_TOPIC: z.string().default("booking-system.public.seats"),

  // Local JWT auth (ADR 0002, replaces Clerk). Required, not optional: an
  // empty/default signing secret would make every token forgeable.
  JWT_SECRET: z.string().min(32, "JWT_SECRET must be at least 32 characters"),
  JWT_EXPIRES_IN: z.string().default("15m"),

  // Origins allowed to call this API cross-origin (e.g. a Vite dev server on
  // a different port than the backend). Explicit allowlist, not a wildcard
  // -- this API issues Authorization: Bearer tokens the frontend attaches
  // itself rather than relying on cookies, so a wildcard wouldn't expose
  // credentials directly, but an explicit list still keeps the browser's
  // CORS error surface meaningful (a typo'd/unexpected origin fails loudly)
  // instead of silently allowing anything that asks.
  CORS_ORIGINS: z
    .string()
    .default("http://localhost:5173")
    .transform((v) =>
      v
        .split(",")
        .map((origin) => origin.trim())
        .filter((origin) => origin.length > 0),
    ),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("Invalid environment variables:");
  console.error(z.prettifyError(parsed.error));
  process.exit(1);
}

export const env = parsed.data;
export type Env = typeof parsed.data;
