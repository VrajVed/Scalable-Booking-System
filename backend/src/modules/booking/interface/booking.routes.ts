import type { FastifyInstance } from "fastify";
import { reserveSeatHandler } from "./booking.controller.js";
import { requireAuth } from "../../../shared/middleware/requireAuth.js";

export async function bookingRoutes(app: FastifyInstance) {
  app.post("/reserve", { preHandler: requireAuth }, reserveSeatHandler);
}
