import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { handleCdcMessage } from "../../src/infrastructure/kafka/cdc-consumer.js";
import { redisConnection } from "../../src/config/redis.js";

// Cross-check: infra/postgres/init.sql defines the seats table column as
// event_id (snake_case) and Debezium's raw JSON payload (schemas.enable=false)
// carries the actual Postgres column names verbatim -- so `event.data.event_id`
// in the consumer does match what a real CDC event contains. That part checks
// out. What doesn't check out is what happens when it's missing (see below).

function debeziumRaw(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    before: null,
    after: { id: 1, event_id: 7, status: "held" },
    op: "u",
    ts_ms: Date.now(),
    ...overrides,
  });
}

describe("handleCdcMessage", () => {
  after(async () => {
    await redisConnection.quit();
  });

  it("deletes the real per-event cache key for a valid update event", async () => {
    const key = "seats:availability:event:7";
    await redisConnection.set(key, "stale-value");

    await handleCdcMessage(debeziumRaw({ op: "u", after: { id: 1, event_id: 7, status: "held" } }));

    const value = await redisConnection.get(key);
    assert.equal(value, null, "the real cache key should have been invalidated");
  });

  it("does NOT build a garbage 'undefined' cache key when event_id is missing", async () => {
    const garbageKey = "seats:availability:event:undefined";
    await redisConnection.set(garbageKey, "should-not-be-touched");

    // A row shape missing event_id entirely (e.g. a bug upstream, or a
    // table added to the CDC topic that isn't 'seats').
    await handleCdcMessage(debeziumRaw({ after: { id: 1, status: "held" } }));

    const value = await redisConnection.get(garbageKey);
    assert.equal(
      value,
      "should-not-be-touched",
      "handleCdcMessage must not blindly issue a DEL against a key built from an undefined event_id",
    );
    await redisConnection.del(garbageKey);
  });

  it("does not throw on malformed JSON — it logs and drops the message", async () => {
    const sentinelKey = "seats:availability:event:7";
    const sentinelValue = "must-survive";
    await redisConnection.set(sentinelKey, sentinelValue);

    await assert.doesNotReject(() => handleCdcMessage("{not valid json"));

    const value = await redisConnection.get(sentinelKey);
    assert.equal(
      value,
      sentinelValue,
      "a malformed payload must not invalidate any cache key — the message is dropped, not partially processed",
    );
    await redisConnection.del(sentinelKey);
  });

  it("does not throw when ts_ms is missing", async () => {
    // The message carries event_id 3, so the only key a buggy handler could
    // touch is seats:availability:event:3 — sentinel it and prove it's not
    // invalidated by a message whose mapper step throws.
    const sentinelKey = "seats:availability:event:3";
    const sentinelValue = "must-survive";
    await redisConnection.set(sentinelKey, sentinelValue);

    const raw = JSON.stringify({ before: null, after: { id: 1, event_id: 3 }, op: "c" });
    await assert.doesNotReject(() => handleCdcMessage(raw));

    const value = await redisConnection.get(sentinelKey);
    assert.equal(
      value,
      sentinelValue,
      "a message that fails to map must be dropped without invalidating any cache key",
    );
    await redisConnection.del(sentinelKey);
  });

  it("does not throw and is a no-op for a DELETE with a null before image", async () => {
    const sentinelKey = "seats:availability:event:7";
    const sentinelValue = "must-survive";
    await redisConnection.set(sentinelKey, sentinelValue);

    const raw = JSON.stringify({ before: null, after: null, op: "d", ts_ms: Date.now() });
    await assert.doesNotReject(() => handleCdcMessage(raw));

    const value = await redisConnection.get(sentinelKey);
    assert.equal(
      value,
      sentinelValue,
      "a DELETE with no before image is a no-op: no cache key may be invalidated",
    );
    await redisConnection.del(sentinelKey);
  });

  it("is a no-op for a null/empty message value", async () => {
    const sentinelKey = "seats:availability:event:7";
    const sentinelValue = "must-survive";
    await redisConnection.set(sentinelKey, sentinelValue);

    await assert.doesNotReject(() => handleCdcMessage(null));
    await assert.doesNotReject(() => handleCdcMessage(undefined));

    const value = await redisConnection.get(sentinelKey);
    assert.equal(
      value,
      sentinelValue,
      "a null/empty message value must not invalidate any cache key",
    );
    await redisConnection.del(sentinelKey);
  });
});
