import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { reserveSeat } from "../application/reserve-seat.usecase.js";

const reserveSeatSchema = z.object({
  seatId: z.coerce.number().int().positive(),
});

export async function reserveSeatHandler(request: FastifyRequest, reply: FastifyReply) {
  const { seatId } = reserveSeatSchema.parse(request.body);
  // requireAuth (a preHandler on this route) is what guarantees userId is
  // set here -- see booking.routes.ts.
  const booking = await reserveSeat({ seatId, userId: request.userId! });
  return reply.status(201).send({ success: true, booking });
}
