"use strict";
// Isolates POST /auth/login: real scrypt password verification + a user
// lookup, zero writes. Registration (setup, not timed) creates the pool;
// the timed run repeats the SAME credentials per connection so this
// measures login cost alone, not registration cost.
const autocannon = require("autocannon");

const TARGET_URL = process.env.TARGET_URL || "http://localhost:3000";
const CONNECTIONS = Number(process.env.CONNECTIONS || 100);
const DURATION = Number(process.env.DURATION || 20);
const REGISTER_CONCURRENCY = 20;

async function registerUser(runId, i) {
  const email = `loadtest-login-${runId}-${i}@example.com`;
  const password = "loadtest-password-123";
  const res = await fetch(`${TARGET_URL}/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const body = await res.json();
  if (!body.success) throw new Error(`register failed for user ${i}: ${JSON.stringify(body)}`);
  return { email, password };
}

async function registerUserPool(n) {
  console.log(`registering ${n} real users via ${TARGET_URL}/auth/register (concurrency ${REGISTER_CONCURRENCY}) ...`);
  const runId = Date.now();
  const creds = new Array(n);
  let next = 0;
  async function worker() {
    while (next < n) {
      const i = next++;
      creds[i] = await registerUser(runId, i);
    }
  }
  await Promise.all(Array.from({ length: REGISTER_CONCURRENCY }, worker));
  console.log(`registered ${n} users`);
  return creds;
}

async function main() {
  const creds = await registerUserPool(CONNECTIONS);
  let credCursor = 0;

  const instance = autocannon(
    {
      url: `${TARGET_URL}/auth/login`,
      connections: CONNECTIONS,
      duration: DURATION,
      method: "POST",
      setupClient: (client) => {
        const { email, password } = creds[credCursor % creds.length];
        credCursor++;
        client.setHeaders({ "content-type": "application/json" });
        // Fixed body: every request from this connection logs in as the
        // same user with the same password -- that's the point, this test
        // isolates login cost, not a varying write path.
        client.setBody(JSON.stringify({ email, password }));
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
