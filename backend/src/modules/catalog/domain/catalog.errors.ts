import { AppError } from "../../../shared/errors/index.js";

export class EventNotFoundError extends AppError {
  constructor(eventId: number) {
    super(`Event ${eventId} not found`, 404, "EVENT_NOT_FOUND");
  }
}
