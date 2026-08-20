import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { registerUser } from "../application/register.usecase.js";
import { loginUser } from "../application/login.usecase.js";

const credentialsSchema = z.object({
  email: z.email(),
  password: z.string().min(8),
});

export async function registerHandler(request: FastifyRequest, reply: FastifyReply) {
  const body = credentialsSchema.parse(request.body);
  const result = await registerUser(body);
  return reply.status(201).send({ success: true, ...result });
}

export async function loginHandler(request: FastifyRequest, reply: FastifyReply) {
  const body = credentialsSchema.parse(request.body);
  const result = await loginUser(body);
  return reply.status(200).send({ success: true, ...result });
}
