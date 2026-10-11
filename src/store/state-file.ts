import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { SUNKEN_VAULT_CAMPAIGN } from "../engine/campaign";
import { awaitingCharacterState } from "../engine/engine";
import type { DndPlayState } from "../engine/types";
import { decryptSecret, encryptSecret, type EncryptedPayload } from "./crypto";

/**
 * The whole game between daily runs: one JSON document, encrypted at rest
 * (the repo is a public fork, and this is committed to its `game-state`
 * branch). No email addresses or keys ever go in here — those stay in env.
 */
export interface GameFile {
  schemaVersion: 1;
  /** Random per run of the campaign (new on every new character) — part of
   *  the dice seed and of outgoing Message-IDs, so neither repeats across
   *  restarts. */
  campaignId: string;
  play: DndPlayState;
  mail: MailBookkeeping;
  /** Finished runs, oldest first. */
  history: FinishedRun[];
}

export interface MailBookkeeping {
  /** When the last turn email (or reminder) went out, ISO — replies received
   *  after this are the ones the next run considers. */
  lastTurnSentAt?: string;
  lastTurnMessageId?: string;
  /** Local date (YYYY-MM-DD in TIMEZONE) of the last run that got past the
   *  due check — makes the daily run exactly-once per day. */
  lastRunLocalDate?: string;
  /** Message-IDs of replies already applied or superseded, newest last. */
  processedMessageIds: string[];
  /** Turn number a "your adventure awaits" reminder was already sent for. */
  remindedForTurn?: number;
}

export interface FinishedRun {
  campaignId: string;
  characterName: string;
  characterClass: string;
  outcome: "won" | "dead" | "restarted";
  turns: number;
  endedAt: string;
}

export const STATE_FILE_NAME = "state.json.enc";
const FORMAT_TAG = "dailydungeon-state";
const MAX_PROCESSED_IDS = 50;

export function newCampaignId(): string {
  return randomBytes(6).toString("hex");
}

export function freshGameFile(): GameFile {
  return {
    schemaVersion: 1,
    campaignId: newCampaignId(),
    play: awaitingCharacterState(SUNKEN_VAULT_CAMPAIGN),
    mail: { processedMessageIds: [] },
    history: [],
  };
}

/** Append reply Message-IDs to the processed list — deduped, capped to the
 *  newest MAX_PROCESSED_IDS (older replies predate lastTurnSentAt anyway). */
export function withProcessed(mail: MailBookkeeping, ids: string[]): MailBookkeeping {
  const merged = [...mail.processedMessageIds.filter((id) => !ids.includes(id)), ...ids];
  return { ...mail, processedMessageIds: merged.slice(-MAX_PROCESSED_IDS) };
}

/** Shape-check a decrypted/hand-edited document before the game trusts it. */
export function validateGameFile(value: unknown): GameFile {
  const doc = value as Partial<GameFile> | null;
  const problems: string[] = [];
  if (!doc || typeof doc !== "object") throw new Error("State is not a JSON object.");
  if (doc.schemaVersion !== 1)
    problems.push(`unsupported schemaVersion ${String(doc.schemaVersion)}`);
  if (typeof doc.campaignId !== "string" || !doc.campaignId) problems.push("missing campaignId");
  if (!doc.play?.character || !doc.play?.gameState || !Array.isArray(doc.play?.turnLog)) {
    problems.push("play must have character, gameState and turnLog");
  }
  if (!doc.mail || !Array.isArray(doc.mail.processedMessageIds)) {
    problems.push("mail.processedMessageIds must be an array");
  }
  if (problems.length > 0) throw new Error(`Invalid state: ${problems.join("; ")}.`);
  return { ...(doc as GameFile), history: Array.isArray(doc.history) ? doc.history : [] };
}

export function encodeGameFile(game: GameFile, keyB64?: string): string {
  const payload = encryptSecret(JSON.stringify(validateGameFile(game)), keyB64);
  return `${JSON.stringify({ format: FORMAT_TAG, ...payload }, null, 2)}\n`;
}

export function decodeGameFile(text: string, keyB64?: string): GameFile {
  let envelope: Partial<EncryptedPayload> & { format?: string };
  try {
    envelope = JSON.parse(text);
  } catch {
    throw new Error("State file is not JSON — expected an encrypted Daily Dungeon state file.");
  }
  if (envelope.format !== FORMAT_TAG || !envelope.ciphertext || !envelope.iv || !envelope.authTag) {
    throw new Error("State file is not an encrypted Daily Dungeon state file.");
  }
  let plaintext: string;
  try {
    plaintext = decryptSecret(
      { ciphertext: envelope.ciphertext, iv: envelope.iv, authTag: envelope.authTag },
      keyB64,
    );
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Couldn't decrypt the state file (${reason}). Is STATE_ENCRYPTION_KEY the key it was written with?`,
    );
  }
  return validateGameFile(JSON.parse(plaintext));
}

/** Where the game lives between runs. */
export interface StateStore {
  /** Human-readable location, for logs. */
  readonly location: string;
  /** null when no game has been saved yet. */
  load(): Promise<GameFile | null>;
  save(game: GameFile): Promise<void>;
}

async function writeAtomically(file: string, contents: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, contents);
  await rename(tmp, file);
}

/** The real store: `<dir>/state.json.enc`, AES-256-GCM with STATE_ENCRYPTION_KEY. */
export function encryptedFileStore(dir: string, keyB64?: string): StateStore {
  const file = path.join(dir, STATE_FILE_NAME);
  return {
    location: file,
    async load() {
      if (!existsSync(file)) return null;
      return decodeGameFile(await readFile(file, "utf8"), keyB64);
    },
    async save(game) {
      await writeAtomically(file, encodeGameFile(game, keyB64));
    },
  };
}

/** Plaintext JSON store for local previews — no key needed, never committed. */
export function plainFileStore(file: string): StateStore {
  return {
    location: file,
    async load() {
      if (!existsSync(file)) return null;
      return validateGameFile(JSON.parse(await readFile(file, "utf8")));
    },
    async save(game) {
      await writeAtomically(file, `${JSON.stringify(validateGameFile(game), null, 2)}\n`);
    },
  };
}
