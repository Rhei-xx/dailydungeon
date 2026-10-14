import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/** Output of AES-256-GCM encryption — what's written to disk as JSON. */
export interface EncryptedPayload {
  ciphertext: string; // base64
  iv: string; // base64
  authTag: string; // base64
}

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const KEY_BYTES = 32;

function resolveKey(keyB64?: string): Buffer {
  const raw = keyB64 ?? process.env.STATE_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error("STATE_ENCRYPTION_KEY is not set");
  }
  const key = Buffer.from(raw, "base64");
  if (key.length !== KEY_BYTES) {
    throw new Error(`STATE_ENCRYPTION_KEY must decode to ${KEY_BYTES} bytes (got ${key.length})`);
  }
  return key;
}

/** Encrypt a UTF-8 string with AES-256-GCM. Key comes from STATE_ENCRYPTION_KEY unless passed. */
export function encryptSecret(plaintext: string, keyB64?: string): EncryptedPayload {
  const key = resolveKey(keyB64);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
  };
}

/** Reverse of {@link encryptSecret}. Throws if the key is wrong or data was tampered with. */
export function decryptSecret(payload: EncryptedPayload, keyB64?: string): string {
  const key = resolveKey(keyB64);
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(payload.iv, "base64"));
  decipher.setAuthTag(Buffer.from(payload.authTag, "base64"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(payload.ciphertext, "base64")),
    decipher.final(),
  ]);
  return plaintext.toString("utf8");
}

/** Generate a fresh base64 key suitable for STATE_ENCRYPTION_KEY. */
export function generateEncryptionKey(): string {
  return randomBytes(KEY_BYTES).toString("base64");
}
