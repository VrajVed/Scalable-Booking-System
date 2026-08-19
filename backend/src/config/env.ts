import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "staging", "production"]).default("development"),
  PORT: z.coerce.number().default(3000),

  DATABASE_URL: z.url(),
  REDIS_URL: z.url(),

  KAFKA_BROKERS: z.string().min(1).transform((v) => v.split(",")),
  KAFKA_CLIENT_ID: z.string().default("flashseat-backend"),
  KAFKA_CDC_GROUP_ID: z.string().default("flashseat-cdc-consumer"),
  KAFKA_CDC_TOPIC: z.string().default("flashseat.public.seats"),

  // Optional until auth is wired into routes — Clerk is vendored from
  // Scalable-Backend-System but not yet gating any endpoints here.
  CLERK_SECRET_KEY: z.string().optional(),
  CLERK_PUBLISHABLE_KEY: z.string().optional(),
  CLERK_WEBHOOK_SECRET: z.string().optional(),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("Invalid environment variables:");
  console.error(z.prettifyError(parsed.error));
  process.exit(1);
}

export const env = parsed.data;
export type Env = typeof parsed.data;
