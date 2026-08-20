import { verifyPassword } from "../../../shared/crypto/password.js";
import { signAuthToken } from "../../../shared/auth/jwt.js";
import { findUserByEmail } from "../infrastructure/user.repository.js";
import { InvalidCredentialsError } from "../domain/auth.errors.js";

export interface LoginInput {
  email: string;
  password: string;
}

// Fixed valid-format scrypt hash of an arbitrary password, never a real
// user's -- exists purely so an unknown email still pays the same scrypt
// cost as a wrong-password attempt on a real account. Without this, a
// non-existent email short-circuits before hashing while a wrong password
// on a real account doesn't, and the two cases -- though they throw the
// identical InvalidCredentialsError -- become distinguishable by response
// latency alone, silently reopening the email-enumeration hole that error
// is designed to close.
const DUMMY_PASSWORD_HASH =
  "4a2ef54ef807453be20f4eb7c0bfe44e:d3be26438fe0e22012c86fb6880cb0c23e4ad1b896b90031faeea5db537123cf7b50e9795335a4d65008fc2cafb65d8201e56efe297241539d7a9d826248a191";

export async function loginUser({ email, password }: LoginInput) {
  const user = await findUserByEmail(email);
  const valid = await verifyPassword(password, user?.passwordHash ?? DUMMY_PASSWORD_HASH);

  if (!user || !valid) {
    throw new InvalidCredentialsError();
  }

  const token = signAuthToken({ userId: user.id });
  return { user: { id: user.id, email: user.email }, token };
}
