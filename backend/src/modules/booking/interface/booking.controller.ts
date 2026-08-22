import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { reserveSeat } from "../application/reserve-seat.usecase.js";
import { confirmBooking } from "../application/confirm-booking.usecase.js";
import { cancelBooking } from "../application/cancel-booking.usecase.js";
import { getBooking } from "../application/get-booking.usecase.js";
import { listBookings } from "../application/list-bookings.usecase.js";

const reserveSeatSchema = z.object({
  seatId: z.coerce.number().int().positive(),
});

const bookingIdParamSchema = z.object({
  bookingId: z.coerce.number().int().positive(),
});

export async function reserveSeatHandler(request: FastifyRequest, reply: FastifyReply) {
  const { seatId } = reserveSeatSchema.parse(request.body);
  // requireAuth (a preHandler on this route) is what guarantees userId is
  // set here -- see booking.routes.ts.
  const booking = await reserveSeat({ seatId, userId: request.userId! });
  return reply.status(201).send({ success: true, booking });
}

export async function confirmBookingHandler(request: FastifyRequest, reply: FastifyReply) {
  const { bookingId } = bookingIdParamSchema.parse(request.params);
  const booking = await confirmBooking({ bookingId, userId: request.userId! });
  return reply.status(200).send({ success: true, booking });
}

export async function cancelBookingHandler(request: FastifyRequest, reply: FastifyReply) {
  const { bookingId } = bookingIdParamSchema.parse(request.params);
  const booking = await cancelBooking({ bookingId, userId: request.userId! });
  return reply.status(200).send({ success: true, booking });
}

export async function getBookingHandler(request: FastifyRequest, reply: FastifyReply) {
  const { bookingId } = bookingIdParamSchema.parse(request.params);
  const booking = await getBooking({ bookingId, userId: request.userId! });
  return reply.status(200).send({ success: true, booking });
}

export async function listBookingsHandler(request: FastifyRequest, reply: FastifyReply) {
  const bookingsForUser = await listBookings(request.userId!);
  return reply.status(200).send({ success: true, bookings: bookingsForUser });
}
