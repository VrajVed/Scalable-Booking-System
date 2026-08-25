import { useEffect, useRef } from "react";
import { liveSeatsUrl } from "./api";
import type { Seat, SeatStatus } from "./types";

interface SeatUpdateMessage {
  type: "seat.updated";
  seatId: number;
  status: SeatStatus;
}

// Subscribes to the backend's CDC-fed WebSocket channel (see
// backend/src/modules/catalog/interface/live.controller.ts) so a seat
// someone else reserves/confirms/releases updates on screen the instant the
// CDC pipeline observes it -- no polling, no manual refresh. Reconnects on
// drop with a short fixed backoff; this is a live-view convenience, not the
// source of truth (the seat's real status is still whatever the next
// reserve attempt gets back from the server).
export function useLiveSeats(eventId: number, onUpdate: (seatId: number, status: Seat["status"]) => void) {
  const onUpdateRef = useRef(onUpdate);
  useEffect(() => {
    onUpdateRef.current = onUpdate;
  }, [onUpdate]);

  useEffect(() => {
    let socket: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;

    function connect() {
      if (cancelled) return;
      socket = new WebSocket(liveSeatsUrl(eventId));

      socket.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data) as SeatUpdateMessage;
          if (msg.type === "seat.updated") {
            onUpdateRef.current(msg.seatId, msg.status);
          }
        } catch {
          // Malformed frame -- ignore, not worth tearing down the socket over.
        }
      };

      socket.onclose = () => {
        if (!cancelled) {
          reconnectTimer = setTimeout(connect, 2000);
        }
      };
    }

    connect();

    return () => {
      cancelled = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      socket?.close();
    };
  }, [eventId]);
}
