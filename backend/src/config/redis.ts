import { Redis } from "ioredis";
import { env } from "./env.js";

export const redisConnection = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});

redisConnection.on("connect", () => {
  console.log("Redis connected");
});

redisConnection.on("error", (err: Error) => {
  console.error("Redis error:", err);
});

// Separate connection OPTIONS for BullMQ (avoids ioredis version conflict)
export const bullMQConnection = {
  host: new URL(env.REDIS_URL).hostname,
  port: Number(new URL(env.REDIS_URL).port) || 6379,
};
