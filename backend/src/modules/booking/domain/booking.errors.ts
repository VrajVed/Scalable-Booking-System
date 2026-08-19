import { AppError } from "../../../shared/errors/index.js";

export class SeatNotFoundError extends AppError {
  constructor(seatId: number) {
    super(`Seat ${seatId} not found`, 404, "SEAT_NOT_FOUND");
  }
}

export class SeatUnavailableError extends AppError {
  constructor(seatId: number) {
    super(`Seat ${seatId} is not available`, 409, "SEAT_UNAVAILABLE");
  }
}
