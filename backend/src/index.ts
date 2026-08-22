import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import { env } from "./config/env.js";
import { errorHandler } from "./shared/middleware/errorHandler.js";
import { rateLimiter } from "./shared/middleware/rateLimiter.js";
import { securityHeaders } from "./shared/middleware/securityHeaders.js";
import { bookingRoutes } from "./modules/booking/interface/booking.routes.js";
import { authRoutes } from "./modules/auth/interface/auth.routes.js";
import { catalogRoutes } from "./modules/catalog/interface/catalog.routes.js";
import { connectProducer } from "./infrastructure/kafka/producer.js";
import { startCdcConsumer, isCdcConsumerConnected } from "./infrastructure/kafka/cdc-consumer.js";
import { startHoldExpiryWorker } from "./infrastructure/queue/hold-expiry.worker.js";
import { registerShutdownHandlers } from "./shutdown.js";
import { redisConnection } from "./config/redis.js";
import { registry, registerHttpMetricsHooks } from "./shared/metrics/registry.js";

const app = Fastify({
  logger: {
    level: env.NODE_ENV === "production" ? "info" : "debug",
    ...(env.NODE_ENV === "development" && {
      transport: {
        target: "pino-pretty",
        options: { colorize: true, translateTime: "HH:MM:ss" },
      },
    }),
  },
  genReqId: () => randomUUID(),
  bodyLimit: 1048576,
  // Trust exactly one hop — lb-proxy — for X-Forwarded-For (ticket 0002).
  // request.ip in rateLimiter is only trustworthy because of this.
  trustProxy: env.TRUST_PROXY_ADDRESSES.split(",")
    .map((s) => s.trim())
    .filter(Boolean),
});

app.setErrorHandler(errorHandler);
app.addHook("preHandler", rateLimiter);

app.addHook("onRequest", async (request, reply) => {
  reply.header("x-request-id", request.id);
});

app.addHook("onSend", securityHeaders);

registerHttpMetricsHooks(app);

app.get("/metrics", async (_request, reply) => {
  reply.header("Content-Type", registry.contentType);
  return registry.metrics();
});

app.get("/health", async (request, reply) => {
  const redisHealthy = await Promise.race([
    redisConnection.ping().then(() => true).catch(() => false),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 2000)),
  ]);

  const cdcConsumer = isCdcConsumerConnected() ? "connected" : "disconnected";

  if (!redisHealthy) {
    reply.status(503);
    return {
      status: "error",
      timestamp: new Date().toISOString(),
      cdcConsumer,
      redis: "unreachable",
    };
  }

  return {
    status: "ok",
    timestamp: new Date().toISOString(),
    cdcConsumer,
    redis: "connected",
  };
});

app.register(bookingRoutes, { prefix: "/bookings" });
app.register(catalogRoutes, { prefix: "/events" });
app.register(authRoutes, { prefix: "/auth" });

const start = async () => {
  try {
    await connectProducer();
    await startCdcConsumer();
    // Starts consuming the hold-expiry queue; ticket 0004's SIGTERM handler
    // is responsible for calling stopHoldExpiryWorker() (exported from
    // ./infrastructure/queue/hold-expiry.worker.js) during graceful shutdown.
    startHoldExpiryWorker();
    // SIGTERM/SIGINT handler (ticket 0004): drains in-flight HTTP requests,
    // then tears down Kafka producer/consumer, the hold-expiry worker, and
    // the DB pool, with a 25s force-exit budget under k8s's 30s grace period.
    // Registered before listen so a signal arriving at boot is still handled.
    registerShutdownHandlers(app);
    await app.listen({ port: env.PORT, host: "0.0.0.0" });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
};

start();
