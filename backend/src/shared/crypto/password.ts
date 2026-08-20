import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scryptAsync = promisify(scrypt);

const KEY_LENGTH = 64;
const SALT_LENGTH = 16;

// node:crypto scrypt instead of argon2/bcrypt: zero extra dependency, no
// native-module Docker build step (argon2/bcrypt both need node-gyp +
// build tooling in the Alpine runtime image), and scrypt is still an OWASP-
// acceptable password KDF. Stored as `${saltHex}:${hashHex}` so verify()
// doesn't need a second lookup for the salt.
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const derivedKey = (await scryptAsync(password, salt, KEY_LENGTH)) as Buffer;
  return `${salt.toString("hex")}:${derivedKey.toString("hex")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [saltHex, hashHex] = stored.split(":");
  if (!saltHex || !hashHex) {
    return false;
  }

  const salt = Buffer.from(saltHex, "hex");
  const storedHash = Buffer.from(hashHex, "hex");
  const derivedKey = (await scryptAsync(password, salt, storedHash.length)) as Buffer;

  // timingSafeEqual throws on length mismatch rather than returning false --
  // guard it explicitly so a malformed/tampered stored hash can't crash the
  // login path instead of just failing it.
  if (derivedKey.length !== storedHash.length) {
    return false;
  }

  return timingSafeEqual(derivedKey, storedHash);
}
