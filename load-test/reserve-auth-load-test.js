"use strict";
// Real authenticated load test against POST /bookings/reserve (ADR 0002).
// Pre-registers a pool of real users via /auth/register (real scrypt hash +
// real JWT issuance, not mocked), then drives autocannon connections that
// each hold one user's token and walk sequential seatIds so most requests
// hit a genuinely available seat instead of instantly 409ing.
//
// Deliberately does NOT use autocannon's `workers` option: worker-thread
// mode re-requires this file in each worker and can't structurally clone a
// `setupClient` closure across threads, so the shared token pool / seatId
// cursor below would silently break. `connections` alone (each an
// independent keep-alive socket driven from one event loop) is the
// concurrency knob here -- plenty for the connection counts this needs.
const autocannon = require("autocannon");

const TARGET_URL = process.env.TARGET_URL || "http://localhost:3000";
const CONNECTIONS = Number(process.env.CONNECTIONS || 100);
const DURATION = Number(process.env.DURATION || 20);
const SEAT_ID_START = Number(process.env.SEAT_ID_START || 32);
const REGISTER_CONCURRENCY = 20;

async function registerUser(runId, i) {
  const res = await fetch(`${TARGET_URL}/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: `loadtest-${runId}-${i}@example.com`,
      password: "loadtest-password-123",
    }),
  });
  const body = await res.json();
  if (!body.token) throw new Error(`register failed for user ${i}: ${JSON.stringify(body)}`);
  return body.token;
}

async function registerUserPool(n) {
  console.log(`registering ${n} real users via ${TARGET_URL}/auth/register (concurrency ${REGISTER_CONCURRENCY}) ...`);
  const runId = Date.now();
  const tokens = new Array(n);
  let next = 0;
  async function worker() {
    while (next < n) {
      const i = next++;
      tokens[i] = await registerUser(runId, i);
    }
  }
  await Promise.all(Array.from({ length: REGISTER_CONCURRENCY }, worker));
  console.log(`registered ${n} users`);
  return tokens;
}

async function main() {
  const tokens = await registerUserPool(CONNECTIONS);
  let tokenCursor = 0;
  let seatCursor = SEAT_ID_START;

  const instance = autocannon(
    {
      url: `${TARGET_URL}/bookings/reserve`,
      connections: CONNECTIONS,
      duration: DURATION,
      method: "POST",
      setupClient: (client) => {
        const token = tokens[tokenCursor % tokens.length];
        tokenCursor++;
        client.setHeaders({ "content-type": "application/json", authorization: `Bearer ${token}` });
        client.setBody(JSON.stringify({ seatId: seatCursor++ }));
        client.on("response", () => {
          client.setBody(JSON.stringify({ seatId: seatCursor++ }));
        });
      },
    },
    (err, result) => {
      if (err) {
        console.error(err);
        process.exit(1);
      }
      console.log(autocannon.printResult(result));
    },
  );

  autocannon.track(instance, { renderProgressBar: true });
  process.once("SIGINT", () => instance.stop());
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
