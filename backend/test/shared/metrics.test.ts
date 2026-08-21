import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import Fastify, { type FastifyInstance } from "fastify";
import { httpRequestsInFlight, registerHttpMetricsHooks } from "../../src/shared/metrics/registry.js";

// Real regression test for the bug fixed in ticket 0012: Fastify's onResponse
// hook only fires on reply.raw's 'finish'/'error' events -- a client that
// aborts before either fires used to leak httpRequestsInFlight upward
// forever. registerHttpMetricsHooks is the exact function index.ts registers
// in production (not a re-implementation), so this exercises the real fix,
// not a copy of it that could silently drift.

let app: FastifyInstance;
let baseUrl: string;

before(async () => {
  app = Fastify({ logger: false });
  registerHttpMetricsHooks(app);

  // Never resolves -- holds the connection open exactly like a slow
  // reserve-seat call would, so the client can abort mid-request.
  app.get("/hang", async () => new Promise(() => {}));
  app.get("/ok", async () => ({ ok: true }));

  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  if (address === null || typeof address === "string") {
    throw new Error("expected app.server.address() to return an AddressInfo");
  }
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await app.close();
});

async function gaugeValue(): Promise<number> {
  const metric = await httpRequestsInFlight.get();
  return metric.values[0]?.value ?? 0;
}

describe("http_requests_in_flight", () => {
  it("returns to 0 after a normal request completes", async () => {
    const before = await gaugeValue();
    const res = await fetch(`${baseUrl}/ok`);
    await res.json();
    assert.equal(await gaugeValue(), before, "gauge must return to its pre-request value after a normal completion");
  });

  it("returns to 0 even when the client aborts before the response ever arrives", async () => {
    const startingValue = await gaugeValue();

    const req = http.get(`${baseUrl}/hang`);
    // Destroying our own request below surfaces as a local socket error on
    // it -- that's the abort working as intended, not a test failure.
    req.on("error", () => {});

    // Give Fastify's onRequest hook time to actually run (increment the
    // gauge) before we abort, so this proves the decrement path, not just
    // that an immediately-destroyed connection never got counted at all.
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(
      await gaugeValue(),
      startingValue + 1,
      "premise check: the in-flight gauge must be incremented while /hang is still pending",
    );

    req.destroy();

    // request.raw's 'close' event is asynchronous relative to the socket
    // tearing down -- poll briefly instead of asserting immediately.
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline && (await gaugeValue()) !== startingValue) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    assert.equal(
      await gaugeValue(),
      startingValue,
      "the in-flight gauge must be released once the client aborts, even though the response never completed",
    );
  });
});
