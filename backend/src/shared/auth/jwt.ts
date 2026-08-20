import jwt from "jsonwebtoken";
import { env } from "../../config/env.js";

export interface AuthTokenPayload {
  userId: number;
}

// Stateless by design (ADR 0002): any backend pod verifies a token with just
// JWT_SECRET, no shared session lookup, so auth composes with P2C's
// per-request routing instead of needing sticky sessions.
export function signAuthToken(payload: AuthTokenPayload): string {
  return jwt.sign(payload, env.JWT_SECRET, {
    expiresIn: env.JWT_EXPIRES_IN as NonNullable<jwt.SignOptions["expiresIn"]>,
  });
}

export function verifyAuthToken(token: string): AuthTokenPayload {
  const decoded = jwt.verify(token, env.JWT_SECRET);
  if (typeof decoded !== "object" || decoded === null || typeof decoded.userId !== "number") {
    throw new jwt.JsonWebTokenError("token payload missing numeric userId");
  }
  return { userId: decoded.userId };
}
