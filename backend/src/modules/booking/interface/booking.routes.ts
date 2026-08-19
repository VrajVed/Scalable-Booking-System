import type { FastifyInstance } from "fastify";
import { reserveSeatHandler } from "./booking.controller.js";

export async function bookingRoutes(app: FastifyInstance) {
  app.post("/reserve", reserveSeatHandler);
}
