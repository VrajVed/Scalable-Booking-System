import type { FastifyRequest, FastifyReply } from "fastify";
import { redisConnection } from "../../config/redis.js";
import { env } from "../../config/env.js";
import { AppError } from "../errors/index.js";

export class RateLimitError extends AppError {
  constructor() {
    super("Too many requests, please try again later", 429, "RATE_LIMIT_EXCEEDED");
  }
}

// Configurable (not hardcoded) so a load test can raise the ceiling for a
// run without weakening the production default -- same rationale as
// HOLD_DURATION_MS being overridable for tests instead of a fixed constant.
const WINDOW_SECONDS = env.RATE_LIMIT_WINDOW_SECONDS;
const MAX_REQUESTS = env.RATE_LIMIT_MAX_REQUESTS;

export const rateLimiter = async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
  // request.ip is computed by Fastify from the X-Forwarded-For chain ONLY
  // when trustProxy (index.ts) says the direct TCP peer is the trusted
  // proxy — lb-proxy, which overwrites the header with the real peer IP.
  // The raw header is deliberately never read here: a client-supplied
  // X-Forwarded-For must not be able to select or rotate its own rate-limit
  // key (the pre-ticket-0002 behavior let anyone dodge the limit by
  // changing the header per request, or get a victim limited by spoofing
  // the victim's IP into it).
  const identifier = request.ip ?? "unknown";
  const key = `rate_limit:${identifier}`;

  const current = await redisConnection.incr(key);

  // Gating this on `current === 1` means the window can only ever get a TTL
  // from the request that happened to be the first increment. If the
  // process crashes (or the request is aborted) between INCR and EXPIRE on
  // that specific request, the key is permanently stuck with no TTL — every
  // later request sees current > 1 and never calls EXPIRE again, so the
  // counter never resets. EXPIRE ... NX (only set a TTL if one isn't
  // already set) is self-healing: it's safe and cheap to call on every
  // request, and it recovers a lost TTL on the very next request instead of
  // requiring it to land exactly on the first increment.
  await redisConnection.expire(key, WINDOW_SECONDS, "NX");

  if (current > MAX_REQUESTS) {
    throw new RateLimitError();
  }
};
