import type { WebSocket } from "@fastify/websocket";

// In-memory room registry: one Set of open sockets per eventId, all on this
// process. That's the right scope for this project -- lb-proxy's P2C
// routing doesn't do sticky sessions (ADR 0002 leans on that deliberately
// for stateless JWT auth), so a client's WebSocket only ever needs to see
// updates for seats in the single event it's viewing, and every backend pod
// independently consumes the same CDC topic below -- no cross-pod fan-out
// needed for a single-room broadcast to reach every socket watching that
// room, wherever it's connected.
const rooms = new Map<number, Set<WebSocket>>();

export function subscribe(eventId: number, socket: WebSocket): void {
  if (!rooms.has(eventId)) {
    rooms.set(eventId, new Set());
  }
  rooms.get(eventId)!.add(socket);
}

export function unsubscribe(eventId: number, socket: WebSocket): void {
  const room = rooms.get(eventId);
  if (!room) return;
  room.delete(socket);
  if (room.size === 0) {
    rooms.delete(eventId);
  }
}

export interface SeatUpdateMessage {
  type: "seat.updated";
  seatId: number;
  eventId: number;
  status: "available" | "held" | "booked";
}

// Called from the CDC consumer (cdc-consumer.ts) -- the same Postgres
// WAL -> Debezium -> Kafka pipeline that already drives zero-polling cache
// invalidation also drives this: a seat UPDATE lands here within one CDC
// round-trip, not a client poll interval.
export function broadcastSeatUpdate(msg: SeatUpdateMessage): void {
  const room = rooms.get(msg.eventId);
  if (!room || room.size === 0) return;

  const payload = JSON.stringify(msg);
  for (const socket of room) {
    // readyState 1 === OPEN. A socket that closed without unsubscribe
    // firing yet (network drop) is skipped rather than throwing.
    if (socket.readyState === 1) {
      socket.send(payload);
    }
  }
}

export function roomSizeForTest(eventId: number): number {
  return rooms.get(eventId)?.size ?? 0;
}
