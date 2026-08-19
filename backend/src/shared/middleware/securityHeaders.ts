import type { FastifyReply, FastifyRequest } from "fastify";

export const securityHeaders = async (_request: FastifyRequest, reply: FastifyReply): Promise<void> => {
  reply.header("X-Content-Type-Options", "nosniff");
  reply.header("X-Frame-Options", "DENY");
  reply.header("X-XSS-Protection", "0");
  reply.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  reply.header("Referrer-Policy", "strict-origin-when-cross-origin");
  reply.header("Permissions-Policy", "geolocation=(), microphone=(), camera=()");
};
