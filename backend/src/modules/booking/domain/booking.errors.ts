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

// Deliberately the same error for "no booking with this id" and "this
// booking exists but isn't yours" -- distinguishing them would let a client
// enumerate valid booking ids by timing/status-code differences alone.
export class BookingNotFoundError extends AppError {
  constructor(bookingId: number) {
    super(`Booking ${bookingId} not found`, 404, "BOOKING_NOT_FOUND");
  }
}

export class BookingNotConfirmableError extends AppError {
  constructor(bookingId: number, status: string) {
    super(`Booking ${bookingId} cannot be confirmed from status '${status}'`, 409, "BOOKING_NOT_CONFIRMABLE");
  }
}

export class BookingNotCancellableError extends AppError {
  constructor(bookingId: number, status: string) {
    super(`Booking ${bookingId} cannot be cancelled from status '${status}'`, 409, "BOOKING_NOT_CANCELLABLE");
  }
}
