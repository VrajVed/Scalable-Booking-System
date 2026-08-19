import type { FastifyRequest, FastifyReply } from "fastify";
import { redisConnection } from "../../config/redis.js";
import { AppError } from "../errors/index.js";

export class RateLimitError extends AppError {
  constructor() {
    super("Too many requests, please try again later", 429, "RATE_LIMIT_EXCEEDED");
  }
}

const WINDOW_SECONDS = 60;
const MAX_REQUESTS = 100;

export const rateLimiter = async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
  const identifier = (request.headers["x-forwarded-for"] as string) ?? request.ip ?? "unknown";
  const key = `rate_limit:${identifier}`;

  const current = await redisConnection.incr(key);

  if (current === 1) {
    await redisConnection.expire(key, WINDOW_SECONDS);
  }

  if (current > MAX_REQUESTS) {
    throw new RateLimitError();
  }
};
