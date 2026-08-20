import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mapDebeziumMessage } from "../../src/infrastructure/kafka/debezium-mapper.js";

function envelope(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    before: null,
    after: { id: 1, event_id: 7, status: "available" },
    op: "c",
    ts_ms: 1700000000000,
    ...overrides,
  });
}

describe("mapDebeziumMessage", () => {
  it("maps op 'c' (create) to INSERT using the 'after' image", () => {
    const event = mapDebeziumMessage(envelope({ op: "c" }));
    assert.equal(event?.type, "INSERT");
    assert.deepEqual(event?.data, { id: 1, event_id: 7, status: "available" });
  });

  it("maps op 'r' (read/snapshot) to INSERT using the 'after' image", () => {
    const event = mapDebeziumMessage(envelope({ op: "r" }));
    assert.equal(event?.type, "INSERT");
  });

  it("maps op 'u' (update) to UPDATE using the 'after' image", () => {
    const event = mapDebeziumMessage(
      envelope({ op: "u", before: { id: 1, status: "available" }, after: { id: 1, status: "held" } }),
    );
    assert.equal(event?.type, "UPDATE");
    assert.deepEqual(event?.data, { id: 1, status: "held" });
  });

  it("maps op 'd' (delete) to DELETE using the 'before' image", () => {
    const event = mapDebeziumMessage(
      envelope({ op: "d", before: { id: 1, status: "held" }, after: null }),
    );
    assert.equal(event?.type, "DELETE");
    assert.deepEqual(event?.data, { id: 1, status: "held" });
  });

  it("returns null for a DELETE with a null 'before' image instead of throwing", () => {
    // With REPLICA IDENTITY FULL this shouldn't happen for the seats table in
    // practice, but the mapper must not crash the consumer loop if it does.
    const event = mapDebeziumMessage(envelope({ op: "d", before: null, after: null }));
    assert.equal(event, null);
  });

  it("returns null for an UPDATE with a null 'after' image", () => {
    const event = mapDebeziumMessage(envelope({ op: "u", before: { id: 1 }, after: null }));
    assert.equal(event, null);
  });

  it("returns null for an op code that isn't c/r/u/d", () => {
    const event = mapDebeziumMessage(envelope({ op: "t" }));
    assert.equal(event, null);
  });

  it("throws a SyntaxError on malformed JSON (caller is responsible for catching it)", () => {
    assert.throws(() => mapDebeziumMessage("{not valid json"), SyntaxError);
  });

  it("throws a RangeError when ts_ms is missing (caller is responsible for catching it)", () => {
    const raw = JSON.stringify({ before: null, after: { id: 1 }, op: "c" });
    assert.throws(() => mapDebeziumMessage(raw), RangeError);
  });

  it("produces an ISO timestamp from ts_ms when present", () => {
    const event = mapDebeziumMessage(envelope({ ts_ms: 1700000000000 }));
    assert.equal(event?.timestamp, new Date(1700000000000).toISOString());
  });
});
