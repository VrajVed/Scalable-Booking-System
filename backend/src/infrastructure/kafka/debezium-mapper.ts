export type CdcEventType = "INSERT" | "UPDATE" | "DELETE";

export interface CdcEvent {
  type: CdcEventType;
  data: Record<string, unknown>;
  timestamp: string;
}

interface DebeziumPayload {
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  op: "c" | "u" | "d" | "r";
  ts_ms: number;
}

const OP_TO_EVENT_TYPE: Record<DebeziumPayload["op"], CdcEventType> = {
  c: "INSERT",
  r: "INSERT", // initial snapshot rows are reported the same as inserts
  u: "UPDATE",
  d: "DELETE",
};

// Debezium (schemas.enable=false) emits the envelope directly as the message
// value — no top-level "schema"/"payload" wrapper to unwrap.
export function mapDebeziumMessage(rawValue: string): CdcEvent | null {
  const payload = JSON.parse(rawValue) as DebeziumPayload;

  const type = OP_TO_EVENT_TYPE[payload.op];
  if (!type) {
    return null;
  }

  const data = type === "DELETE" ? payload.before : payload.after;
  if (!data) {
    return null;
  }

  return {
    type,
    data,
    timestamp: new Date(payload.ts_ms).toISOString(),
  };
}
