import type { FastifyError, FastifyReply, FastifyRequest } from "fastify";
import { z, ZodError } from "zod";
import { AppError } from "../errors/index.js";

export const errorHandler = (
  error: FastifyError | AppError | Error,
  request: FastifyRequest,
  reply: FastifyReply,
): FastifyReply => {
  request.log.error({ err: error }, error.message);

  if (error instanceof AppError) {
    return reply.status(error.statusCode).send({
      success: false,
      code: error.code,
      message: error.message,
    });
  }

  if (error instanceof ZodError) {
    return reply.status(400).send({
      success: false,
      code: "VALIDATION_ERROR",
      message: z.prettifyError(error),
    });
  }

  if ("statusCode" in error && error.statusCode === 400) {
    return reply.status(400).send({
      success: false,
      code: "VALIDATION_ERROR",
      message: error.message,
    });
  }

  return reply.status(500).send({
    success: false,
    code: "INTERNAL_SERVER_ERROR",
    message: "Something went wrong",
  });
};
