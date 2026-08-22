import { findEventById, listSeatsForEvent as listSeatsForEventQuery } from "../infrastructure/catalog.repository.js";
import { EventNotFoundError } from "../domain/catalog.errors.js";

export interface ListSeatsForEventInput {
  eventId: number;
  status?: "available" | "held" | "booked" | undefined;
}

export async function listSeatsForEvent({ eventId, status }: ListSeatsForEventInput) {
  const event = await findEventById(eventId);
  if (!event) {
    throw new EventNotFoundError(eventId);
  }

  return listSeatsForEventQuery(eventId, status);
}
