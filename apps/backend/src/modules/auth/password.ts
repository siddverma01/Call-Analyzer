import { hash as argon2Hash, verify as argon2Verify } from "@node-rs/argon2";
import { createHash, randomBytes } from "node:crypto";

/**
 * Password hashing via Argon2id. Plaintext passwords are never stored.
 * Argon2id is memory-hard and recommended for interactive logins.
 */
export function hashPassword(password: string): Promise<string> {
  return argon2Hash(password);
}

export function verifyPassword(hash: string, password: string): Promise<boolean> {
  return argon2Verify(hash, password);
}

/**
 * Session token generation. The token is returned to the client verbatim while
 * only its SHA-256 digest is stored in the database, so a leaked database does
 * not leak usable session tokens.
 */
export function generateSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}