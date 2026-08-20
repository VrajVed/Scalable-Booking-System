import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import { authRoutes } from "../../src/modules/auth/interface/auth.routes.js";
import { errorHandler } from "../../src/shared/middleware/errorHandler.js";
import { verifyAuthToken } from "../../src/shared/auth/jwt.js";
import { closeDb } from "../../src/infrastructure/database/db.js";
import { deleteTestUser } from "../helpers/db.js";

let app: FastifyInstance;
const createdUserIds: number[] = [];

before(async () => {
  app = Fastify({ logger: false });
  app.setErrorHandler(errorHandler);
  await app.register(authRoutes, { prefix: "/auth" });
  await app.ready();
});

after(async () => {
  await app.close();
  for (const id of createdUserIds) {
    await deleteTestUser(id);
  }
  await closeDb();
});

function uniqueEmail(): string {
  return `test-${randomUUID()}@example.com`;
}

describe("POST /auth/register", () => {
  it("400s when email is not a valid email", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { email: "not-an-email", password: "supersecret123" },
    });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().code, "VALIDATION_ERROR");
  });

  it("400s when password is shorter than 8 characters", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { email: uniqueEmail(), password: "short" },
    });
    assert.equal(res.statusCode, 400);
  });

  it("201s with a real signed JWT on a valid registration", async () => {
    const email = uniqueEmail();
    const res = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { email, password: "supersecret123" },
    });
    assert.equal(res.statusCode, 201);
    const body = res.json();
    assert.equal(body.success, true);
    assert.equal(body.user.email, email);
    assert.equal(typeof body.user.id, "number");
    createdUserIds.push(body.user.id);

    // Positive proof the token is real and verifiable, not just present.
    const payload = verifyAuthToken(body.token);
    assert.equal(payload.userId, body.user.id);
  });

  it("409s with EMAIL_ALREADY_REGISTERED when the email is already taken", async () => {
    const email = uniqueEmail();
    const first = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { email, password: "supersecret123" },
    });
    createdUserIds.push(first.json().user.id);

    const second = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { email, password: "a-different-password" },
    });
    assert.equal(second.statusCode, 409);
    assert.equal(second.json().code, "EMAIL_ALREADY_REGISTERED");
  });
});

describe("POST /auth/login", () => {
  it("logs in with the correct password and issues a verifiable token", async () => {
    const email = uniqueEmail();
    const password = "correct-horse-battery";
    const registerRes = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { email, password },
    });
    createdUserIds.push(registerRes.json().user.id);

    const loginRes = await app.inject({ method: "POST", url: "/auth/login", payload: { email, password } });
    assert.equal(loginRes.statusCode, 200);
    const body = loginRes.json();
    assert.equal(body.user.email, email);
    const payload = verifyAuthToken(body.token);
    assert.equal(payload.userId, body.user.id);
  });

  it("401s with INVALID_CREDENTIALS on a wrong password", async () => {
    const email = uniqueEmail();
    const registerRes = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { email, password: "the-real-password" },
    });
    createdUserIds.push(registerRes.json().user.id);

    const res = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email, password: "totally-wrong-password" },
    });
    assert.equal(res.statusCode, 401);
    assert.equal(res.json().code, "INVALID_CREDENTIALS");
  });

  it("401s with INVALID_CREDENTIALS for an email that was never registered", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: uniqueEmail(), password: "irrelevant-password" },
    });
    assert.equal(res.statusCode, 401);
    assert.equal(res.json().code, "INVALID_CREDENTIALS");
  });

  it(
    "an unknown email takes roughly as long to reject as a wrong password on a real account " +
      "(both must pay the same scrypt cost, or response latency leaks which emails are registered)",
    async () => {
      const email = uniqueEmail();
      const registerRes = await app.inject({
        method: "POST",
        url: "/auth/register",
        payload: { email, password: "the-real-password-for-timing-test" },
      });
      createdUserIds.push(registerRes.json().user.id);

      const timeRequest = async (payload: { email: string; password: string }) => {
        const start = performance.now();
        await app.inject({ method: "POST", url: "/auth/login", payload });
        return performance.now() - start;
      };

      // Warm up (JIT/first-call overhead) before the timed samples.
      await timeRequest({ email, password: "totally-wrong-password" });

      const N = 8;
      const knownUserWrongPasswordTimes: number[] = [];
      const unknownEmailTimes: number[] = [];
      for (let i = 0; i < N; i++) {
        knownUserWrongPasswordTimes.push(await timeRequest({ email, password: "totally-wrong-password" }));
        unknownEmailTimes.push(await timeRequest({ email: uniqueEmail(), password: "irrelevant-password" }));
      }

      const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
      const knownMedian = median(knownUserWrongPasswordTimes);
      const unknownMedian = median(unknownEmailTimes);

      // Without the DUMMY_PASSWORD_HASH fix, an unknown email returns almost
      // immediately (one cheap DB lookup, no scrypt), while a wrong password
      // on a real account pays a real scrypt derivation -- tens of ms.
      // Asserting the unknown-email path takes at least half the known-user
      // path's time (generous slack for scheduler/CI jitter) fails loudly if
      // that short-circuit regresses, without asserting exact equality on
      // inherently noisy wall-clock timings.
      assert.ok(
        unknownMedian >= knownMedian * 0.5,
        `expected unknown-email median (${unknownMedian.toFixed(2)}ms) to be within the same order of ` +
          `magnitude as known-user-wrong-password median (${knownMedian.toFixed(2)}ms) -- a much faster ` +
          `unknown-email response means it's skipping the scrypt hash and leaking which emails are registered`,
      );
    },
  );
});
