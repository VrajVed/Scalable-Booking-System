export interface User {
  id: number;
  email: string;
}

export interface EventSummary {
  id: number;
  name: string;
  startsAt: string;
  status: "scheduled" | "cancelled" | "completed";
  venueId: number;
  venueName: string;
  venueCity: string;
}

export type SeatStatus = "available" | "held" | "booked";

export interface Seat {
  id: number;
  eventId: number;
  section: string;
  rowLabel: string;
  seatNumber: number;
  status: SeatStatus;
  version: number;
  createdAt: string;
}

export type BookingStatus = "pending" | "confirmed" | "cancelled" | "expired";

export interface Booking {
  id: number;
  seatId: number;
  userId: number;
  status: BookingStatus;
  holdExpiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}
