import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret, generateEncryptionKey } from "./crypto";

describe("crypto", () => {
  const key = generateEncryptionKey();

  it("round-trips plaintext", () => {
    const plaintext = '{"character":{"name":"Brakka"}}';
    const enc = encryptSecret(plaintext, key);
    expect(enc.ciphertext).not.toContain("Brakka");
    expect(decryptSecret(enc, key)).toBe(plaintext);
  });

  it("produces a fresh IV each call", () => {
    const a = encryptSecret("same", key);
    const b = encryptSecret("same", key);
    expect(a.iv).not.toBe(b.iv);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  it("fails to decrypt with the wrong key", () => {
    const enc = encryptSecret("secret", key);
    expect(() => decryptSecret(enc, generateEncryptionKey())).toThrow();
  });

  it("rejects a key of the wrong length", () => {
    const shortKey = Buffer.from("too-short").toString("base64");
    expect(() => encryptSecret("x", shortKey)).toThrow(/32 bytes/);
  });
});
