import { hashPassword } from "../../../shared/crypto/password.js";
import { signAuthToken } from "../../../shared/auth/jwt.js";
import { createUser, findUserByEmail } from "../infrastructure/user.repository.js";
import { EmailAlreadyRegisteredError } from "../domain/auth.errors.js";

export interface RegisterInput {
  email: string;
  password: string;
}

export async function registerUser({ email, password }: RegisterInput) {
  const existing = await findUserByEmail(email);
  if (existing) {
    throw new EmailAlreadyRegisteredError();
  }

  const passwordHash = await hashPassword(password);

  let user;
  try {
    user = await createUser({ email, passwordHash });
  } catch (err) {
    // Race window between the findUserByEmail check above and this insert:
    // two concurrent registrations for the same email both pass the check,
    // then one insert wins and the other hits the DB's unique constraint
    // (Postgres error code 23505). Translate that into the same domain
    // error the pre-check produces instead of surfacing a raw 500.
    if (typeof err === "object" && err !== null && "code" in err && err.code === "23505") {
      throw new EmailAlreadyRegisteredError();
    }
    throw err;
  }

  const token = signAuthToken({ userId: user.id });
  return { user: { id: user.id, email: user.email }, token };
}
