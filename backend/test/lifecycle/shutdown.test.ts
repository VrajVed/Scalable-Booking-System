import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import Fastify, { type FastifyInstance } from "fastify";
import {
  gracefulShutdown,
  makeDefaultShutdownDeps,
  registerShutdownHandlers,
  type ShutdownDeps,
} from "../../src/shutdown.js";
import { closeHoldExpiryQueue } from "../../src/infrastructure/queue/hold-expiry.queue.js";
import { redisConnection } from "../../src/config/redis.js";
import { closeDb } from "../../src/infrastructure/database/db.js";

// The module under test imports index-free infrastructure modules whose
// module-level singletons (ioredis in config/redis.ts, BullMQ's queue) hold
// the event loop open; mirror the booking.controller.test.ts after-hook
// pattern so this file doesn't hang the suite.
after(async () => {
  await redisConnection.quit();
  await closeHoldExpiryQueue();
  await closeDb();
});

function noopDeps(overrides: Partial<ShutdownDeps> = {}): ShutdownDeps {
  const noop = async () => {};
  return {
    closeServer: overrides.closeServer ?? noop,
    stopProducer: overrides.stopProducer ?? noop,
    stopCdcConsumer: overrides.stopCdcConsumer ?? noop,
    stopHoldExpiryWorker: overrides.stopHoldExpiryWorker ?? noop,
    closeDb: overrides.closeDb ?? noop,
  };
}

function waitFor(predicate: () => boolean, timeoutMs: number, intervalMs = 20): Promise<boolean> {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const poll = () => {
      if (predicate()) return resolve(true);
      if (Date.now() >= deadline) return resolve(predicate());
      setTimeout(poll, intervalMs);
    };
    poll();
  });
}

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("gracefulShutdown — teardown ordering and awaiting", () => {
  it("calls each teardown step strictly in order, waiting for each to resolve before starting the next", async () => {
    const calls: string[] = [];
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const logs: string[] = [];

    const deps = noopDeps({
      closeServer: async () => {
        calls.push("http");
        await gate; // do NOT resolve until the test says so
      },
      stopProducer: async () => calls.push("producer"),
      stopCdcConsumer: async () => calls.push("cdc"),
      stopHoldExpiryWorker: async () => calls.push("worker"),
      closeDb: async () => calls.push("db"),
    });

    const shutdownPromise = gracefulShutdown({ close: async () => {} }, deps, (m) => logs.push(m));

    // While closeServer is still awaiting its gate, NO later step may run:
    // the drain sequence must not barrel ahead into teardown.
    await waitFor(() => calls.length >= 1, 1000);
    assert.deepEqual(calls, ["http"], "closeServer must start first and be awaited before anything else runs");
    await tick(100);
    assert.deepEqual(
      calls,
      ["http"],
      "steps after closeServer must not start while the previous step is still in flight",
    );

    releaseGate();
    await shutdownPromise;

    assert.deepEqual(
      calls,
      ["http", "producer", "cdc", "worker", "db"],
      "teardown must run http -> producer -> cdc consumer -> hold-expiry worker -> db pool, each awaited",
    );
    assert.equal(
      logs.indexOf("[shutdown] drain complete"),
      logs.length - 1,
      "the drain-complete marker must be the last log line, after all five steps finished",
    );
  });

  it("continues past a failing step instead of skipping the remaining teardown", async () => {
    const calls: string[] = [];
    const logs: string[] = [];
    const deps = noopDeps({
      closeServer: async () => calls.push("http"),
      stopProducer: async () => {
        calls.push("producer");
        throw new Error("kafka producer refused to disconnect");
      },
      stopCdcConsumer: async () => calls.push("cdc"),
      stopHoldExpiryWorker: async () => calls.push("worker"),
      closeDb: async () => calls.push("db"),
    });

    await gracefulShutdown({ close: async () => {} }, deps, (m) => logs.push(m));

    assert.deepEqual(calls, ["http", "producer", "cdc", "worker", "db"]);
    assert.ok(
      logs.some((m) => m.includes("error closing kafka-producer")),
      "the failing step's error must be logged, not swallowed silently",
    );
  });
});

describe("gracefulShutdown — blocks on in-flight HTTP work", () => {
  it("does not resolve while a request handler is still running, and delivers the full response before teardown closes anything", async () => {
    const events: string[] = [];
    let releaseRequest!: () => void;
    const requestGate = new Promise<void>((resolve) => {
      releaseRequest = resolve;
    });
    let handlerStarted = false;

    const app: FastifyInstance = Fastify({ logger: false });
    // Server-side flush marker for the delivery-order proof below. The
    // client's own read-completion ("http-response-arrived") races with the
    // server's close-completion by event-loop scheduling — it can land after
    // "[shutdown] closed http-server" even when the response was fully
    // delivered (verified separately via status + body). res 'finish' is the
    // synchronous point where the full response is handed to the transport,
    // and it deterministically precedes the close-completion chain
    // (finish -> reap -> socket close -> server close()).
    app.server.on("request", (_req, res) => {
      res.on("finish", () => events.push("http-response-flushed"));
    });
    app.get("/slow", async (_request, _reply) => {
      handlerStarted = true;
      await requestGate;
      return { done: true };
    });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const { port } = app.server.address() as AddressInfo;

    const deps = noopDeps({
      // Real closeServer from makeDefaultShutdownDeps — the production drain
      // path index.ts would use: app.close() plus the keep-alive reaper that
      // lets Node's server.close() resolve once the in-flight socket goes
      // idle. The other subsystems stay no-ops so this proof isolates the
      // HTTP drain.
      closeServer: makeDefaultShutdownDeps(app).closeServer,
      stopProducer: async () => events.push("[shutdown] closed kafka-producer"),
    });

    const responsePromise = fetch(`http://127.0.0.1:${port}/slow`).then((res) =>
      res.json().then((body) => {
        events.push("http-response-arrived");
        return { status: res.status, body };
      }),
    );

    assert.ok(
      await waitFor(() => handlerStarted, 1000),
      "premise check: the slow handler must actually be running before we start the shutdown",
    );

    const shutdownPromise = gracefulShutdown(app, deps, (m) => events.push(m));

    // The in-flight request is held open: shutdown must NOT resolve and the
    // response must NOT arrive while the handler is still blocked.
    await tick(300);
    const resolvedEarly = await Promise.race([
      shutdownPromise.then(() => true),
      tick(50).then(() => false),
    ]);
    assert.equal(resolvedEarly, false, "shutdown must block while an in-flight request handler is unresolved");
    assert.ok(!events.includes("http-response-arrived"), "the blocked request's response must not arrive early");
    assert.ok(
      !events.some((e) => e.startsWith("[shutdown] closed")),
      "no teardown step may complete while in-flight work is still running",
    );

    // Release the handler: only now may the response be delivered and the
    // drain finish — and the response must arrive strictly before the
    // http-server close step is logged as complete.
    releaseRequest();

    const response = await responsePromise;
    const resolved = await Promise.race([shutdownPromise.then(() => true), tick(2000).then(() => false)]);
    assert.equal(resolved, true, "shutdown must resolve once the in-flight request completes");

    assert.equal(response.status, 200, "the drained request must receive a complete, successful response");
    assert.deepEqual(response.body, { done: true });
    assert.ok(
      events.indexOf("http-response-flushed") < events.indexOf("[shutdown] closed http-server"),
      "the in-flight response must be fully flushed to the transport BEFORE the http server's close is " +
        "recorded — teardown started too early if this fails",
    );
  });
});

describe("registerShutdownHandlers — signal handling", () => {
  const uninstallers: Array<() => void> = [];

  function emitSignal(signal: "SIGTERM" | "SIGINT") {
    // Synthetic dispatch: process.emit only runs listeners registered via
    // process.on — it does NOT trigger Node's real OS-signal termination, so
    // the test runner itself is never at risk.
    process.emit(signal, signal);
  }

  after(() => {
    for (const uninstall of uninstallers) uninstall();
  });

  it("drains on a single SIGTERM, logs the full ordered sequence, then exits 0", async () => {
    const exitCalls: number[] = [];
    const logs: string[] = [];
    const calls: string[] = [];

    const uninstall = registerShutdownHandlers(
      // deps.closeServer below is what actually runs — deps is explicitly
      // supplied, so this app stub is only used for its type shape.
      { close: async () => {} },
      {
        timeoutMs: 5000,
        exit: (code) => {
          exitCalls.push(code);
          return undefined as never;
        },
        log: (m) => logs.push(m),
        deps: noopDeps({
          closeServer: async () => calls.push("http"),
          stopProducer: async () => calls.push("producer"),
          stopCdcConsumer: async () => calls.push("cdc"),
          stopHoldExpiryWorker: async () => calls.push("worker"),
          closeDb: async () => calls.push("db"),
        }),
      },
    );
    uninstallers.push(uninstall);

    emitSignal("SIGTERM");
    assert.ok(
      await waitFor(() => exitCalls.length > 0, 2000),
      "exit must be called after the drain sequence completes",
    );

    assert.deepEqual(exitCalls, [0], "a clean drain must exit with code 0");
    assert.deepEqual(calls, ["http", "producer", "cdc", "worker", "db"]);

    const order = [
      "[shutdown] SIGTERM received — draining in-flight work",
      "[shutdown] closing http-server",
      "[shutdown] closed http-server",
      "[shutdown] closing kafka-producer",
      "[shutdown] closed kafka-producer",
      "[shutdown] closing kafka-cdc-consumer",
      "[shutdown] closed kafka-cdc-consumer",
      "[shutdown] closing hold-expiry-worker",
      "[shutdown] closed hold-expiry-worker",
      "[shutdown] closing postgres-pool",
      "[shutdown] closed postgres-pool",
      "[shutdown] drain complete",
      "[shutdown] complete — exiting",
    ];
    let prev = -1;
    for (const marker of order) {
      const idx = logs.indexOf(marker);
      assert.notEqual(idx, -1, `expected log marker '${marker}' to be present`);
      assert.ok(idx > prev, `log markers must appear in order; '${marker}' came before an earlier marker`);
      prev = idx;
    }
  });

  it("a second signal while draining forces an immediate exit(1) instead of waiting out the budget", async () => {
    const exitCalls: number[] = [];
    let releaseClose!: () => void;
    const closeGate = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });

    const uninstall = registerShutdownHandlers(
      {
        close: async () => {
          await closeGate; // drain stuck on the http step
        },
      },
      {
        timeoutMs: 2000,
        exit: (code) => {
          exitCalls.push(code);
          return undefined as never;
        },
        deps: noopDeps({
          closeServer: async () => {
            await closeGate; // drain stuck on the http step
          },
        }),
      },
    );
    uninstallers.push(uninstall);

    emitSignal("SIGTERM");
    await tick(50); // let the first signal's drain begin
    emitSignal("SIGTERM");

    assert.ok(
      await waitFor(() => exitCalls.length > 0, 1000),
      "the second signal must trigger an immediate force-exit while the drain is stuck",
    );
    assert.deepEqual(exitCalls, [1], "escalation on a second signal must exit with code 1");

    releaseClose();
  });
});