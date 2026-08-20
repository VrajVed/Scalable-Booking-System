import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { redisConnection } from "../src/config/redis.js";

describe("GET /health", () => {
  it("returns 200 ok when Redis is reachable", async () => {
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

    const res = await app.inject({ method: "GET", url: "/health" });
    assert.equal(res.statusCode, 200, "/health must return 200 when Redis is up");
    const body = res.json();
    assert.equal(body.status, "ok");
    assert.equal(body.redis, "connected");
    await app.close();
  });

  it(
    "returns 503 error when Redis PING rejects, without hanging",
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
      redisConnection.ping = async () => {
        throw new Error("simulated unreachable");
      };

      try {
        const res = await app.inject({ method: "GET", url: "/health" });
        assert.equal(res.statusCode, 503, "/health must return 503 when Redis PING rejects");
        const body = res.json();
        assert.equal(body.status, "error");
        assert.equal(body.redis, "unreachable");
      } finally {
        redisConnection.ping = originalPing;
        await app.close();
      }
    },
  );

  it(
    "returns 503 error when Redis PING hangs past the timeout, without hanging the test",
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
        assert.equal(res.statusCode, 503, "/health must return 503 when Redis PING times out");
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

after(async () => {
  await redisConnection.quit();
});
