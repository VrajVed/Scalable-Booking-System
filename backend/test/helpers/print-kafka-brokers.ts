// Tiny helper script run as a subprocess: prints env.KAFKA_BROKERS as JSON
// so the test can assert on it without importing env.ts (which parses
// process.env at import time and calls process.exit(1) on failure) into
// the main test process.
import { env } from "../../src/config/env.js";

process.stdout.write(JSON.stringify(env.KAFKA_BROKERS));
