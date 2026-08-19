import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import { env } from "./config/env.js";
import { errorHandler } from "./shared/middleware/errorHandler.js";
import { rateLimiter } from "./shared/middleware/rateLimiter.js";
import { securityHeaders } from "./shared/middleware/securityHeaders.js";
import { bookingRoutes } from "./modules/booking/interface/booking.routes.js";
import { connectProducer } from "./infrastructure/kafka/producer.js";
import { startCdcConsumer, isCdcConsumerConnected } from "./infrastructure/kafka/cdc-consumer.js";

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
});

app.setErrorHandler(errorHandler);
app.addHook("preHandler", rateLimiter);

app.addHook("onRequest", async (request, reply) => {
  reply.header("x-request-id", request.id);
});

app.addHook("onSend", securityHeaders);

app.get("/health", async () => ({
  status: "ok",
  timestamp: new Date().toISOString(),
  cdcConsumer: isCdcConsumerConnected() ? "connected" : "disconnected",
}));

app.register(bookingRoutes, { prefix: "/bookings" });

const start = async () => {
  try {
    await connectProducer();
    await startCdcConsumer();
    await app.listen({ port: env.PORT, host: "0.0.0.0" });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
};

start();
