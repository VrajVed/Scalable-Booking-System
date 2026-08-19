import { createClerkClient } from "@clerk/backend";
import { env } from "../../config/env.js";

// Not wired into any routes yet — created here so the booking flow can add
// requireAuth() later without touching this file.
export const clerkClient = env.CLERK_SECRET_KEY
  ? createClerkClient({ secretKey: env.CLERK_SECRET_KEY })
  : null;
