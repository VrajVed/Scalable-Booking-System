import type { WebSocket } from "@fastify/websocket";
import type { FastifyRequest } from "fastify";
import { z } from "zod";
import { subscribe, unsubscribe } from "../../../infrastructure/realtime/seat-broadcaster.js";

const eventIdParamSchema = z.object({
  eventId: z.coerce.number().int().positive(),
});

// Push-only channel: a client connects to watch one event's seat map and
// gets a { type: "seat.updated", seatId, status } message the instant the
// CDC pipeline (Postgres WAL -> Debezium -> Kafka -> this consumer, see
// cdc-consumer.ts) observes that seat change -- no polling, no refetch
// loop. No auth required, matching the rest of catalog: watching seats
// flip live is part of browsing, same as GET /events/:id/seats.
export function liveSeatsHandler(socket: WebSocket, request: FastifyRequest) {
  const parsed = eventIdParamSchema.safeParse(request.params);
  if (!parsed.success) {
    socket.close(1008, "invalid eventId");
    return;
  }

  const { eventId } = parsed.data;
  subscribe(eventId, socket);

  socket.on("close", () => {
    unsubscribe(eventId, socket);
  });
}
