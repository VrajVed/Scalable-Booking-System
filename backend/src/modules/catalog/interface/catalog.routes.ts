import type { FastifyInstance } from "fastify";
import { listEventsHandler, listSeatsForEventHandler } from "./catalog.controller.js";

// Deliberately no requireAuth here -- browsing what's on sale doesn't
// require a login on any real ticketing site, only reserving a seat does
// (see booking.routes.ts).
export async function catalogRoutes(app: FastifyInstance) {
  app.get("/", listEventsHandler);
  app.get("/:eventId/seats", listSeatsForEventHandler);
}
