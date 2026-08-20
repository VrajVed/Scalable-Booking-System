import type { Server } from "node:http";
import { disconnectProducer } from "./infrastructure/kafka/producer.js";
import { stopCdcConsumer } from "./infrastructure/kafka/cdc-consumer.js";
import { stopHoldExpiryWorker } from "./infrastructure/queue/hold-expiry.worker.js";
import { closeDb } from "./infrastructure/database/db.js";

// Graceful shutdown for ticket 0004, mirroring lb-proxy's shape: stop
// accepting new work first (Fastify close() drains in-flight HTTP requests),
// then tear down the publishers/consumers/workers that produced or depended
// on that work, then the DB pool. Each step uses the existing exported
// teardown function for its subsystem — nothing here reinvents teardown
// logic that already lives in the infrastructure modules.
//
// Everything is injectable so the tests can prove ordering/blocking at the
// function level without a real broker stack; index.ts wires the real
// defaults.
//
// Keep-alive drain gap (why the default closeServer has a reaper): Node's
// http.Server.close() invokes closeIdleConnections() exactly once,
// synchronously, at the moment close() is called (httpServerPreClose in
// _http_server.js). Fastify reaches that point slightly later — after its
// preClose hook chain — so a request that is mid-flight at SIGTERM time is
// skipped by that single reap (closeIdleConnections only destroys sockets
// with no unfinished response), and once its response finishes the now-idle
// keep-alive socket is never reaped again. It stays open until the client's
// keep-alive timeout, so close()'s promise never resolves and the drain
// would hang until the force-exit budget. Fastify's own "Connection: close"
// header on closing servers only stamps requests dispatched AFTER closing
// began (route.js), not the one already in flight. The event-driven reaper
// below closes that gap without polling or touching in-flight work:
// closeIdleConnections() is re-invoked after each response finishes while
// draining.

export interface ShutdownDeps {
  closeServer: () => Promise<void>;
  stopProducer: () => Promise<void>;
  stopCdcConsumer: () => Promise<void>;
  stopHoldExpiryWorker: () => Promise<void>;
  closeDb: () => Promise<void>;
}

export interface ShutdownOptions {
  // k8s default terminationGracePeriodSeconds is 30s; the drain budget sits
  // under it (same reasoning as lb-proxy's 25s) so a stuck connection or a
  // hung external call can't block shutdown so long that SIGKILL lands.
  timeoutMs?: number;
  exit?: (code: number) => never;
  log?: (message: string) => void;
  deps?: ShutdownDeps;
}

// Structural surface used by makeDefaultShutdownDeps' closeServer: a Fastify
// instance satisfies it (app.server is the underlying http.Server); stub
// apps in tests can omit server entirely. Holds runtime guards, so this also
// degrades safely on Node versions without closeIdleConnections (< 18.2).
export interface DrainingHttpApp {
  close(): Promise<void>;
  server?: Server;
}

// Per-server drain reaper state. The WeakMap means re-installing shutdown
// handlers (or calling makeDefaultShutdownDeps repeatedly) never stacks
// duplicate 'request' listeners.
const drainReapers = new WeakMap<Server, { beginDrain: () => void }>();

function drainReaperFor(server: Server): { beginDrain: () => void } {
  const existing = drainReapers.get(server);
  if (existing) return existing;

  let draining = false;
  server.on("request", (_req, res) => {
    res.on("finish", () => {
      // A response finishing is the exact moment a request's socket becomes
      // idle. While draining, reap it (and any other idle keep-alive socket)
      // so server.close()'s promise can resolve. closeIdleConnections()
      // skips sockets with an unfinished response, so in-flight work is
      // never cut off — the response is fully flushed before 'finish' fires.
      if (draining && typeof server.closeIdleConnections === "function") {
        server.closeIdleConnections();
      }
    });
  });

  const reaper = {
    beginDrain: () => {
      draining = true;
    },
  };
  drainReapers.set(server, reaper);
  return reaper;
}

export function makeDefaultShutdownDeps(app: DrainingHttpApp): ShutdownDeps {
  // Attach the reaper NOW (bootstrap time, before any requests arrive) —
  // attaching at closeServer-run time would miss requests already in flight
  // when SIGTERM lands, because their 'request' event fired before the
  // listener existed. index.ts calls this before app.listen().
  const server = app.server;
  const reaper = server ? drainReaperFor(server) : null;
  return {
    closeServer: async () => {
      reaper?.beginDrain();
      if (server) {
        // Initiate close first (stops accepting new connections), then reap
        // the sockets that are already idle — e.g. k8s probe keep-alives
        // parked on the pod — before waiting for in-flight requests.
        const closePromise = app.close();
        if (typeof server.closeIdleConnections === "function") {
          server.closeIdleConnections();
        }
        await closePromise;
      } else {
        await app.close();
      }
    },
    stopProducer: disconnectProducer,
    stopCdcConsumer,
    stopHoldExpiryWorker,
    closeDb,
  };
}

// Runs the drain sequence in a fixed order — HTTP first (this is where the
// in-flight work is), then the things that handle deferred work, then the
// pool every handler read/wrote through. A failure in one step must not skip
// the rest: each step is awaited and logged, errors are logged and the
// sequence continues so the remaining subsystems still get a clean close.
export async function gracefulShutdown(
  app: { close(): Promise<void> },
  deps: ShutdownDeps = makeDefaultShutdownDeps(app),
  log: (message: string) => void = console.log,
): Promise<void> {
  const steps: Array<[name: string, run: () => Promise<void>]> = [
    ["http-server", deps.closeServer],
    ["kafka-producer", deps.stopProducer],
    ["kafka-cdc-consumer", deps.stopCdcConsumer],
    ["hold-expiry-worker", deps.stopHoldExpiryWorker],
    ["postgres-pool", deps.closeDb],
  ];

  for (const [name, run] of steps) {
    try {
      log(`[shutdown] closing ${name}`);
      await run();
      log(`[shutdown] closed ${name}`);
    } catch (err) {
      log(`[shutdown] error closing ${name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  log("[shutdown] drain complete");
}

// Installs the SIGTERM/SIGINT handler. First signal starts the drain with a
// bounded budget (timeoutMs, default 25s — under k8s's 30s grace period):
// if the drain hasn't finished when the budget expires we force-exit rather
// than let k8s SIGKILL us. A second signal while draining exits immediately;
// once the drain finishes we exit 0 so the process doesn't linger on any
// remaining third-party handle (the ioredis singleton in config/redis.ts
// has no teardown export and would otherwise keep the event loop alive).
export function registerShutdownHandlers(
  app: { close(): Promise<void> },
  options: ShutdownOptions = {},
): () => void {
  const { timeoutMs = 25_000, exit = (code: number) => process.exit(code), log = console.log } = options;
  const deps = options.deps ?? makeDefaultShutdownDeps(app);

  let draining = false;

  const onSignal = (signal: NodeJS.Signals): void => {
    if (draining) {
      log(`[shutdown] second ${signal} during drain — forcing immediate exit`);
      exit(1);
      return;
    }
    draining = true;
    log(`[shutdown] ${signal} received — draining in-flight work`);

    const forceTimer = setTimeout(() => {
      log(`[shutdown] drain exceeded ${timeoutMs}ms budget — forcing exit`);
      exit(1);
    }, timeoutMs);
    forceTimer.unref();

    gracefulShutdown(app, deps, log)
      .then(() => {
        clearTimeout(forceTimer);
        log("[shutdown] complete — exiting");
        exit(0);
      })
      .catch((err: unknown) => {
        clearTimeout(forceTimer);
        log(`[shutdown] teardown failed: ${err instanceof Error ? err.message : String(err)}`);
        exit(1);
      });
  };

  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);

  return () => {
    process.off("SIGTERM", onSignal);
    process.off("SIGINT", onSignal);
  };
}