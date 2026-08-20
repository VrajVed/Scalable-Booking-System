import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const helperScript = path.join(__dirname, "..", "helpers", "print-kafka-brokers.ts");
const tsxBin = path.join(__dirname, "..", "..", "node_modules", ".bin", "tsx");

const BASE_ENV = {
  PATH: process.env.PATH ?? "",
  NODE_ENV: "development",
  DATABASE_URL: "postgres://user:pass@localhost:5432/db",
  REDIS_URL: "redis://localhost:6379",
  JWT_SECRET: "test-secret-at-least-32-characters-long",
};

function runWithBrokers(kafkaBrokers: string) {
  return spawnSync(tsxBin, [helperScript], {
    encoding: "utf-8",
    env: { ...BASE_ENV, KAFKA_BROKERS: kafkaBrokers },
  });
}

describe("env.ts KAFKA_BROKERS parsing", () => {
  it("splits a clean comma-separated broker list", () => {
    const result = runWithBrokers("broker-a:9092,broker-b:9092");
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), ["broker-a:9092", "broker-b:9092"]);
  });

  it("does not produce an empty-string broker entry from a trailing comma", () => {
    const result = runWithBrokers("broker-a:9092,");
    assert.equal(result.status, 0, result.stderr);
    const brokers = JSON.parse(result.stdout);
    assert.ok(
      !brokers.includes(""),
      `expected no empty broker entries, got: ${JSON.stringify(brokers)}`,
    );
  });

  it("does not produce an empty-string broker entry from a double comma", () => {
    const result = runWithBrokers("broker-a:9092,,broker-b:9092");
    assert.equal(result.status, 0, result.stderr);
    const brokers = JSON.parse(result.stdout);
    assert.ok(
      !brokers.includes(""),
      `expected no empty broker entries, got: ${JSON.stringify(brokers)}`,
    );
    assert.deepEqual(brokers, ["broker-a:9092", "broker-b:9092"]);
  });

  it("rejects a broker list that is only commas (no real brokers) instead of silently accepting it", () => {
    const result = runWithBrokers(",,");
    assert.notEqual(result.status, 0, "process should exit non-zero on an all-empty broker list");
  });
});
