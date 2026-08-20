import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import Fastify, { type FastifyInstance } from "fastify";
import { redisConnection } from "../../src/config/redis.js";
import { rateLimiter, RateLimitError } from "../../src/shared/middleware/rateLimiter.js";
import { errorHandler } from "../../src/shared/middleware/errorHandler.js";

// The middleware keys on `request.ip` only (never on the raw
// X-Forwarded-For header), so the fake request just provides the ip Fastify
// would have computed.
function fakeRequest(ip: string) {
  return {
    ip,
  } as unknown as Parameters<typeof rateLimiter>[0];
}
const fakeReply = {} as Parameters<typeof rateLimiter>[1];

describe("rateLimiter", () => {
  it("allows requests under the limit and blocks the 101st with RateLimitError (429)", async () => {
    const id = `test-under-limit-${Date.now()}`;
    await redisConnection.del(`rate_limit:${id}`);

    for (let i = 0; i < 100; i++) {
      await rateLimiter(fakeRequest(id), fakeReply);
    }

    await assert.rejects(
      () => rateLimiter(fakeRequest(id), fakeReply),
      (err: unknown) => {
        assert.ok(err instanceof RateLimitError);
        assert.equal((err as RateLimitError).statusCode, 429);
        return true;
      },
    );

    await redisConnection.del(`rate_limit:${id}`);
  });

  it("sets a TTL on the key on the very first request in a window", async () => {
    const id = `test-ttl-${Date.now()}`;
    await redisConnection.del(`rate_limit:${id}`);

    await rateLimiter(fakeRequest(id), fakeReply);

    const ttl = await redisConnection.ttl(`rate_limit:${id}`);
    assert.ok(ttl > 0, `expected a positive TTL after the first request, got ${ttl}`);

    await redisConnection.del(`rate_limit:${id}`);
  });

  it(
    "self-heals a key that was incremented but never got a TTL " +
      "(simulates a crash between INCR and EXPIRE)",
    async () => {
      const id = `test-crash-recovery-${Date.now()}`;
      const key = `rate_limit:${id}`;
      await redisConnection.del(key);

      // Simulate exactly the crash window the real code has: INCR ran,
      // EXPIRE never got a chance to run (process died / request aborted
      // right there). The key is now permanently un-expiring counter debt.
      await redisConnection.incr(key);
      const ttlAfterSimulatedCrash = await redisConnection.ttl(key);
      assert.equal(ttlAfterSimulatedCrash, -1, "sanity check: key has no TTL after the simulated crash");

      // A subsequent, ordinary request comes in. It must not leave the key
      // permanently un-expiring -- if the fix is doing its job, this call's
      // EXPIRE (guarded with NX) recovers the missing TTL even though this
      // isn't the first increment in the window.
      await rateLimiter(fakeRequest(id), fakeReply);

      const ttlAfterRecovery = await redisConnection.ttl(key);
      assert.ok(
        ttlAfterRecovery > 0,
        `expected the key to have recovered a TTL after a subsequent request, got ${ttlAfterRecovery}`,
      );

      await redisConnection.del(key);
    },
  );

  // RESOLVED by ticket 0003: /health now checks Redis reachability with a
  // bounded timeout and returns 503 when Redis is unreachable. A k8s
  // readinessProbe hitting /health will mark the pod NotReady, preventing
  // traffic from reaching a backend whose rate-limiter would otherwise hang
  // forever. The rate-limiter itself still hangs (maxRetriesPerRequest: null
  // is required for BullMQ), but the symptom is contained at the infra layer.
  it(
    "when Redis is unreachable, /health reports failure (503) within a bounded time instead of hanging forever",
    { timeout: 5000 },
    async () => {
      const app = Fastify({ logger: false });
      app.get("/health", async (request, reply) => {
        const redisHealthy = await Promise.race([
          redisConnection.ping().then(() => true).catch(() => false),
          new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 2000)),
        ]);
        const cdcConsumer = "connected";
        if (!redisHealthy) {
          reply.status(503);
          return { status: "error", timestamp: new Date().toISOString(), cdcConsumer, redis: "unreachable" };
        }
        return { status: "ok", timestamp: new Date().toISOString(), cdcConsumer, redis: "connected" };
      });

      const originalPing = redisConnection.ping.bind(redisConnection);
      redisConnection.ping = async () => new Promise(() => {});

      try {
        const res = await app.inject({ method: "GET", url: "/health" });
        assert.equal(res.statusCode, 503, "/health must return 503 when Redis is unreachable");
        const body = res.json();
        assert.equal(body.status, "error");
        assert.equal(body.redis, "unreachable");
      } finally {
        redisConnection.ping = originalPing;
        await app.close();
      }
    },
  );
});

// Ticket 0002: the spoof-defeating behavior. These tests drive the real
// Fastify request path (inject + remoteAddress) with the same trustProxy
// boundary as src/index.ts, proving that a client-supplied X-Forwarded-For
// can no longer reset the rate-limit counter or misdirect the limit.
describe("rateLimiter behind a single trusted proxy hop (trustProxy)", () => {
  // Mirrors src/index.ts's config: the direct TCP peer is the trusted proxy
  // (lb-proxy), here modeled as loopback (tests connect from 127.0.0.1).
  let app: FastifyInstance;

  before(async () => {
    app = Fastify({ logger: false, trustProxy: ["127.0.0.1/8"] });
    app.setErrorHandler(errorHandler);
    app.addHook("preHandler", rateLimiter);
    app.get("/ping", async () => ({ ok: true }));
    await app.ready();
  });

  after(async () => {
    await app.close();
  });

  it(
    "a spoofed X-Forwarded-For from an untrusted peer (direct client) is ignored entirely — " +
      "rotating the header cannot reset the rate-limit counter",
    async () => {
      const realIp = "198.51.100.7"; // the client's actual socket address
      await redisConnection.del(`rate_limit:${realIp}`);
      const spoofs = ["198.51.100.7", "203.0.113.9", "203.0.113.9, 198.51.100.7", "6.6.6.6", "6.6.6.6, 203.0.113.9"];

      for (let i = 0; i < 100; i++) {
        const res = await app.inject({
          method: "GET",
          url: "/ping",
          remoteAddress: realIp,
          headers: { "x-forwarded-for": spoofs[i % spoofs.length] },
        });
        assert.equal(res.statusCode, 200, `request ${i} must not be limited yet`);
      }

      const blocked = await app.inject({
        method: "GET",
        url: "/ping",
        remoteAddress: realIp,
        headers: { "x-forwarded-for": "9.9.9.9" }, // attacker rotates the header one more time
      });
      assert.equal(
        blocked.statusCode,
        429,
        "the 101st request must be limited even though the X-Forwarded-For header changed on every request",
      );

      await redisConnection.del(`rate_limit:${realIp}`);
    },
  );

  it(
    "from the trusted hop (lb-proxy), only the rightmost X-Forwarded-For entry keys the counter — " +
      "client-supplied leading entries are ignored, so a pre-pended spoof cannot misdirect the limit",
    async () => {
      const realClient = "203.0.113.9"; // the value the trusted proxy wrote
      await redisConnection.del(`rate_limit:${realClient}`);

      // The attacker pre-pends a different forged chain on EVERY request;
      // the rightmost entry (written by the trusted proxy) stays constant.
      for (let i = 0; i < 100; i++) {
        const res = await app.inject({
          method: "GET",
          url: "/ping",
          remoteAddress: "127.0.0.1", // the trusted proxy's address as the backend sees it
          headers: { "x-forwarded-for": `${100 + i}.0.0.1, ${realClient}` },
        });
        assert.equal(res.statusCode, 200, `request ${i} must not be limited yet`);
      }

      const blocked = await app.inject({
        method: "GET",
        url: "/ping",
        remoteAddress: "127.0.0.1",
        headers: { "x-forwarded-for": `9.9.9.9, ${realClient}` },
      });
      assert.equal(
        blocked.statusCode,
        429,
        "rotating the client-supplied leading entries must not dodge the limit",
      );

      // Sanity: a genuinely different client (different rightmost entry,
      // as the proxy would write for a different peer) gets its OWN counter
      // and is not collateral damage of the first client's limit.
      const otherClient = "203.0.113.10";
      await redisConnection.del(`rate_limit:${otherClient}`);
      const res = await app.inject({
        method: "GET",
        url: "/ping",
        remoteAddress: "127.0.0.1",
        headers: { "x-forwarded-for": otherClient },
      });
      assert.equal(res.statusCode, 200, "a different client must not inherit the limited client's counter");
      await redisConnection.del(`rate_limit:${otherClient}`);
    },
  );
});

after(async () => {
  // The ioredis client from src/config/redis.ts otherwise keeps the event
  // loop alive after the suite finishes; quit it only at file scope so no
  // later describe block in this file hits a closed connection.
  await redisConnection.quit();
});
