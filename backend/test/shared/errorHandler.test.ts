import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { z, ZodError } from "zod";
import { errorHandler } from "../../src/shared/middleware/errorHandler.js";
import { AppError } from "../../src/shared/errors/index.js";

function fakeRequest() {
  return { log: { error: () => {} } } as unknown as Parameters<typeof errorHandler>[1];
}

function fakeReply() {
  const state: { statusCode?: number; body?: unknown } = {};
  const reply = {
    status(code: number) {
      state.statusCode = code;
      return reply;
    },
    send(body: unknown) {
      state.body = body;
      return reply;
    },
  };
  return { reply: reply as unknown as Parameters<typeof errorHandler>[2], state };
}

describe("errorHandler", () => {
  it("never leaks a stack trace into the HTTP response for a generic Error", () => {
    const err = new Error("boom - sensitive internal detail: /etc/passwd, db password=hunter2");
    const { reply, state } = fakeReply();

    errorHandler(err, fakeRequest(), reply);

    assert.equal(state.statusCode, 500);
    const bodyText = JSON.stringify(state.body);
    assert.ok(err.stack, "sanity check: the error actually has a stack");
    assert.ok(!bodyText.includes("at Object"), "response must not contain stack frame text");
    assert.ok(!bodyText.includes("errorHandler.test.ts"), "response must not contain file paths from the stack");
    assert.ok(!bodyText.includes("hunter2"), "response must not leak the original error message at all for generic errors");
    assert.deepEqual(state.body, {
      success: false,
      code: "INTERNAL_SERVER_ERROR",
      message: "Something went wrong",
    });
  });

  it("returns the AppError's own statusCode/code/message, not a generic 500", () => {
    const err = new AppError("Seat 5 is not available", 409, "SEAT_UNAVAILABLE");
    const { reply, state } = fakeReply();

    errorHandler(err, fakeRequest(), reply);

    assert.equal(state.statusCode, 409);
    assert.deepEqual(state.body, {
      success: false,
      code: "SEAT_UNAVAILABLE",
      message: "Seat 5 is not available",
    });
  });

  it("returns 400 VALIDATION_ERROR for a ZodError, not a 500", () => {
    const schema = z.object({ seatId: z.number().int().positive() });
    let zodError: ZodError;
    try {
      schema.parse({ seatId: -1 });
      throw new Error("expected schema.parse to throw");
    } catch (e) {
      zodError = e as ZodError;
    }

    const { reply, state } = fakeReply();
    errorHandler(zodError, fakeRequest(), reply);

    assert.equal(state.statusCode, 400);
    assert.equal((state.body as { code: string }).code, "VALIDATION_ERROR");
  });
});
