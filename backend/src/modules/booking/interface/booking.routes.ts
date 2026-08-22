import type { FastifyInstance } from "fastify";
import {
  reserveSeatHandler,
  confirmBookingHandler,
  cancelBookingHandler,
  getBookingHandler,
  listBookingsHandler,
} from "./booking.controller.js";
import { requireAuth } from "../../../shared/middleware/requireAuth.js";

export async function bookingRoutes(app: FastifyInstance) {
  app.post("/reserve", { preHandler: requireAuth }, reserveSeatHandler);
  app.get("/", { preHandler: requireAuth }, listBookingsHandler);
  app.get("/:bookingId", { preHandler: requireAuth }, getBookingHandler);
  app.post("/:bookingId/confirm", { preHandler: requireAuth }, confirmBookingHandler);
  app.post("/:bookingId/cancel", { preHandler: requireAuth }, cancelBookingHandler);
}
