import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { generateEncryptionKey } from "./crypto";
import {
  STATE_FILE_NAME,
  decodeGameFile,
  encodeGameFile,
  encryptedFileStore,
  freshGameFile,
  plainFileStore,
  validateGameFile,
  withProcessed,
} from "./state-file";

describe("freshGameFile", () => {
  it("starts a campaign waiting for a character, with nothing sent yet", () => {
    const game = freshGameFile();
    expect(game.play.gameState.status).toBe("awaiting_character");
    expect(game.mail).toEqual({ processedMessageIds: [] });
    expect(game.campaignId).toMatch(/^[0-9a-f]{12}$/);
  });
});

describe("encode/decode", () => {
  const key = generateEncryptionKey();

  it("round-trips a game without leaking it in plaintext", () => {
    const game = freshGameFile();
    game.play.character.name = "Brakka";
    const text = encodeGameFile(game, key);
    expect(text).not.toContain("Brakka");
    expect(JSON.parse(text).format).toBe("dailydungeon-state");
    expect(decodeGameFile(text, key)).toEqual(game);
  });

  it("explains a wrong key instead of throwing a bare crypto error", () => {
    const text = encodeGameFile(freshGameFile(), key);
    expect(() => decodeGameFile(text, generateEncryptionKey())).toThrow(/STATE_ENCRYPTION_KEY/);
  });

  it("rejects files that aren't encrypted state", () => {
    expect(() => decodeGameFile("not json", key)).toThrow(/not JSON/);
    expect(() => decodeGameFile('{"hello":1}', key)).toThrow(/not an encrypted/);
  });
});

describe("validateGameFile", () => {
  it("rejects documents missing the core sections", () => {
    expect(() => validateGameFile({ schemaVersion: 2 })).toThrow(/unsupported schemaVersion 2/);
    const broken = { ...freshGameFile(), mail: {} };
    expect(() => validateGameFile(broken)).toThrow(/processedMessageIds/);
  });

  it("defaults a missing history to empty", () => {
    const { history: _h, ...rest } = freshGameFile();
    expect(validateGameFile(rest).history).toEqual([]);
  });
});

describe("withProcessed", () => {
  it("appends, dedupes and keeps only the newest 50", () => {
    const ids = Array.from({ length: 50 }, (_, i) => `<${i}@x>`);
    const mail = withProcessed({ processedMessageIds: ids }, ["<0@x>", "<new@x>"]);
    expect(mail.processedMessageIds).toHaveLength(50);
    expect(mail.processedMessageIds.at(-1)).toBe("<new@x>");
    expect(mail.processedMessageIds.at(-2)).toBe("<0@x>");
    expect(mail.processedMessageIds).not.toContain("<1@x>");
  });
});

describe("stores", () => {
  it("encryptedFileStore saves to <dir>/state.json.enc and loads it back", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "dd-state-"));
    const key = generateEncryptionKey();
    const store = encryptedFileStore(dir, key);
    expect(await store.load()).toBeNull();

    const game = freshGameFile();
    await store.save(game);
    expect(store.location).toBe(path.join(dir, STATE_FILE_NAME));
    expect(await readFile(store.location, "utf8")).toContain('"ciphertext"');
    expect(await store.load()).toEqual(game);
  });

  it("plainFileStore reads and writes readable JSON", async () => {
    const file = path.join(await mkdtemp(path.join(tmpdir(), "dd-plain-")), "state.json");
    const store = plainFileStore(file);
    const game = freshGameFile();
    await store.save(game);
    expect(JSON.parse(await readFile(file, "utf8")).campaignId).toBe(game.campaignId);
    await writeFile(file, JSON.stringify({ ...game, history: undefined }));
    expect((await store.load())?.history).toEqual([]);
  });
});
