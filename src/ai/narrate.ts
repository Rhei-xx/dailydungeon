import type { TextModel } from "./gemini";

export interface NarrationInput {
  characterName: string;
  characterClass: string;
  /** Room the turn started in. */
  fromRoom: string;
  /** Room the hero ends the turn in, and what it looks like. */
  toRoom: string;
  toRoomDescription: string;
  /** The player's move as understood. */
  move: string;
  /** The engine's account of what happened, in order — the only facts allowed. */
  events: string[];
  outcome: "ongoing" | "won" | "dead" | "new_character";
}

const SYSTEM = `You narrate a solo Dungeons & Dragons adventure that is played by email, one turn a day.

Write 2 to 4 sentences of second-person, present-tense narration for the turn described.
- Narrate ONLY what the list of events says happened, in that order. Do not invent creatures, items, exits, wounds, outcomes or consequences that aren't in the events.
- Do not include any numbers (dice, HP, AC, damage) — the mechanics are shown separately under your text.
- You may draw atmosphere from the room description.
- If the hero died, be solemn. If they won, be triumphant. If a new hero just arrived, set the scene.
- Plain text only: no markdown, no headings, no quotation marks around the whole thing.`;

const MAX_CHARS = 1200;

/** Plain engine text — used whenever the narrator is unavailable. */
export function fallbackNarration(input: NarrationInput): string {
  return input.events.join(" ");
}

/** Tidy model prose: drop markdown emphasis and wrapping quotes, cap length. */
export function cleanNarration(text: string): string {
  let clean = text
    .replace(/[*_#`]+/g, "")
    .replace(/\s+\n/g, "\n")
    .trim();
  if (/^["“].*["”]$/s.test(clean)) clean = clean.slice(1, -1).trim();
  return clean.length > MAX_CHARS ? `${clean.slice(0, MAX_CHARS).trimEnd()}…` : clean;
}

/**
 * A short story paragraph for the turn. The engine already decided every
 * outcome; this only dresses it up, and falls back to the engine's own
 * sentences if there's no model or it fails.
 */
export async function narrate(
  model: TextModel | null,
  input: NarrationInput,
): Promise<{ text: string; source: "gemini" | "fallback" }> {
  if (!model || input.events.length === 0) {
    return { text: fallbackNarration(input), source: "fallback" };
  }
  try {
    const prompt = [
      `Hero: ${input.characterName} the ${input.characterClass}.`,
      `Turn started in: ${input.fromRoom}.`,
      `Turn ends in: ${input.toRoom} — ${input.toRoomDescription}`,
      `The player's move: ${input.move || "(none)"}`,
      `Outcome: ${input.outcome}.`,
      "Events, in order:",
      ...input.events.map((e) => `- ${e}`),
    ].join("\n");
    const text = cleanNarration(await model.text({ system: SYSTEM, prompt }));
    if (!text) throw new Error("empty narration");
    return { text, source: "gemini" };
  } catch (err) {
    console.warn("narrate: falling back to engine text:", err instanceof Error ? err.message : err);
    return { text: fallbackNarration(input), source: "fallback" };
  }
}
