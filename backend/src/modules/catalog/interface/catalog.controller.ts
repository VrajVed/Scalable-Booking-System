import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { listEvents } from "../application/list-events.usecase.js";
import { listSeatsForEvent } from "../application/list-seats-for-event.usecase.js";

const eventIdParamSchema = z.object({
  eventId: z.coerce.number().int().positive(),
});

const seatsQuerySchema = z.object({
  status: z.enum(["available", "held", "booked"]).optional(),
});

export async function listEventsHandler(_request: FastifyRequest, reply: FastifyReply) {
  const eventsList = await listEvents();
  return reply.status(200).send({ success: true, events: eventsList });
}

export async function listSeatsForEventHandler(request: FastifyRequest, reply: FastifyReply) {
  const { eventId } = eventIdParamSchema.parse(request.params);
  const { status } = seatsQuerySchema.parse(request.query);
  const seatsList = await listSeatsForEvent({ eventId, status });
  return reply.status(200).send({ success: true, seats: seatsList });
}
