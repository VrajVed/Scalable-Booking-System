import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { reserveSeat } from "../application/reserve-seat.usecase.js";

const reserveSeatSchema = z.object({
  seatId: z.coerce.number().int().positive(),
  userId: z.string().min(1),
});

export async function reserveSeatHandler(request: FastifyRequest, reply: FastifyReply) {
  const body = reserveSeatSchema.parse(request.body);
  const booking = await reserveSeat(body);
  return reply.status(201).send({ success: true, booking });
}
