import type { Booking, EventSummary, Seat, SeatStatus, User } from "./types";

const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:3000";

export class ApiError extends Error {
  code: string;
  status: number;

  constructor(message: string, code: string, status: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

let authToken: string | null = null;

export function setAuthToken(token: string | null) {
  authToken = token;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
      ...init?.headers,
    },
  });

  const body = await res.json().catch(() => null);

  if (!res.ok) {
    throw new ApiError(
      body?.message ?? "Something went wrong",
      body?.code ?? "UNKNOWN_ERROR",
      res.status,
    );
  }

  return body as T;
}

export function register(email: string, password: string) {
  return request<{ success: true; user: User; token: string }>("/auth/register", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
}

export function login(email: string, password: string) {
  return request<{ success: true; user: User; token: string }>("/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
}

export async function listEvents() {
  const res = await request<{ success: true; events: EventSummary[] }>("/events");
  return res.events;
}

export async function listSeatsForEvent(eventId: number, status?: SeatStatus, limit?: number) {
  const params = new URLSearchParams();
  if (status) params.set("status", status);
  if (limit) params.set("limit", String(limit));
  const query = params.toString() ? `?${params.toString()}` : "";
  const res = await request<{ success: true; seats: Seat[] }>(`/events/${eventId}/seats${query}`);
  return res.seats;
}

export async function reserveSeat(seatId: number) {
  const res = await request<{ success: true; booking: Booking }>("/bookings/reserve", {
    method: "POST",
    body: JSON.stringify({ seatId }),
  });
  return res.booking;
}

export async function listBookings() {
  const res = await request<{ success: true; bookings: Booking[] }>("/bookings");
  return res.bookings;
}

export async function getBooking(bookingId: number) {
  const res = await request<{ success: true; booking: Booking }>(`/bookings/${bookingId}`);
  return res.booking;
}

export async function confirmBooking(bookingId: number) {
  const res = await request<{ success: true; booking: Booking }>(`/bookings/${bookingId}/confirm`, {
    method: "POST",
  });
  return res.booking;
}

export async function cancelBooking(bookingId: number) {
  const res = await request<{ success: true; booking: Booking }>(`/bookings/${bookingId}/cancel`, {
    method: "POST",
  });
  return res.booking;
}
