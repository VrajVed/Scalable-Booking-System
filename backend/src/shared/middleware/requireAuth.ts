import type { FastifyRequest, FastifyReply } from "fastify";
import jwt from "jsonwebtoken";
import { verifyAuthToken } from "../auth/jwt.js";
import { AppError } from "../errors/index.js";

export class UnauthorizedError extends AppError {
  constructor(message = "Missing or invalid authorization token") {
    super(message, 401, "UNAUTHORIZED");
  }
}

declare module "fastify" {
  interface FastifyRequest {
    // Set only after requireAuth runs; routes that need it must list
    // requireAuth as a preHandler, not just import this type.
    userId?: number;
  }
}

// Verifies the Authorization: Bearer <jwt> header and decorates the request
// with the token's userId (ADR 0002). Deliberately the only source of
// userId for authenticated routes -- a client-supplied userId in the
// request body would let anyone book seats as anyone else.
export async function requireAuth(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
  const header = request.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    throw new UnauthorizedError();
  }

  const token = header.slice("Bearer ".length);

  try {
    const payload = verifyAuthToken(token);
    request.userId = payload.userId;
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) {
      throw new UnauthorizedError("Token expired");
    }
    throw new UnauthorizedError();
  }
}
