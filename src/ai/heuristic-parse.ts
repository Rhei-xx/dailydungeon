import { ABILITIES, CLASS_IDS } from "../engine/rules";
import type { DndAbility, DndAction, DndPlayerRolls, DndTurnInput } from "../engine/types";
import {
  expectsCharacter,
  explicitlyAsksToRestart,
  type ParseContext,
  type ParsedReply,
} from "./reply-types";

/**
 * A conservative keyword reader — the fallback when Gemini is unavailable
 * (no key, an outage) and the parser behind `preview --offline`. It only acts
 * on words it's sure of; anything else comes back "unclear" rather than
 * guessed, so a bad read costs a day, never a wrong move.
 */

const ACTION_WORDS: [DndAction, RegExp][] = [
  // Engine priority order: sneak > flee > dodge > attack.
  ["sneak", /\b(sneak|sneaking|stealth(il)?y?|creep|tiptoe|slip past)\b/i],
  ["flee", /\b(flee|run away|run for it|retreat|escape)\b/i],
  ["dodge", /\b(dodge|defend|parry|take cover)\b/i],
  ["attack", /\b(attack|hit|strike|swing|fight|kill|stab|slash|shoot|smash|chop)\b/i],
];

const ROLL_WORDS: [keyof DndPlayerRolls, string][] = [
  ["toHit", "to[ -]?hit"],
  ["damage", "damage|dmg"],
  ["stealth", "stealth"],
  ["perception", "perception"],
  ["initiative", "initiative|init"],
  ["heal", "heal(?:ing)?"],
];

const ABILITY_WORDS: Record<DndAbility, string> = {
  strength: "str(?:ength)?",
  dexterity: "dex(?:terity)?",
  constitution: "con(?:stitution)?",
  intelligence: "int(?:elligence)?",
  wisdom: "wis(?:dom)?",
  charisma: "cha(?:risma)?",
};

/** "to hit 15", "15 to hit", "to-hit: 15", "damage of 6". */
function findNumberNear(text: string, words: string): number | null {
  const after = new RegExp(`\\b(?:${words})\\b\\s*(?:of|was|is|=|:)?\\s*(-?\\d{1,2})\\b`, "i").exec(
    text,
  );
  if (after) return Number(after[1]);
  const before = new RegExp(`\\b(-?\\d{1,2})\\s+(?:${words})\\b`, "i").exec(text);
  return before ? Number(before[1]) : null;
}

function parseCharacter(text: string): ParsedReply {
  const classId = CLASS_IDS.find((c) => new RegExp(`\\b${c}\\b`, "i").test(text)) ?? null;
  const named =
    /\b(?:name(?:'s| is)?|call me|i am|i'm)\s*:?\s*([A-Z][\w'-]{1,30})/i.exec(text) ??
    /^\s*([A-Z][\w'-]{1,30})\s*,/.exec(text);
  const name = named && !CLASS_IDS.includes(named[1].toLowerCase() as never) ? named[1] : null;

  const scores: Partial<Record<DndAbility, number | null>> = {};
  for (const ability of ABILITIES) {
    const value = findNumberNear(text, ABILITY_WORDS[ability]);
    scores[ability] = value != null && value >= 1 && value <= 20 ? value : null;
  }

  const parts = [name ?? "an unnamed hero", classId ? `the ${classId}` : "class left to the dice"];
  return {
    intent: "character",
    character: { name, class: classId, scores },
    summary: `New character: ${parts.join(", ")}.`,
    source: "heuristic",
  };
}

export function heuristicParse(text: string, ctx: ParseContext): ParsedReply {
  if (expectsCharacter(ctx.status)) return parseCharacter(text);

  if (explicitlyAsksToRestart(text)) {
    return { intent: "restart", summary: "Start over with a new character.", source: "heuristic" };
  }

  const action = ACTION_WORDS.find(([, re]) => re.test(text))?.[0] ?? "none";
  const exit = ctx.exits.find((dir) => new RegExp(`\\b${dir}\\b`, "i").test(text)) ?? null;
  const drinkPotion = /\b(potion|drink|quaff)\b/i.test(text);
  const search = /\b(search|look around|loot|inspect|investigate|examine)\b/i.test(text);

  const rolls: DndPlayerRolls = {};
  for (const [key, words] of ROLL_WORDS) {
    const value = findNumberNear(text, words);
    if (value != null) rolls[key] = value;
  }

  if (action === "none" && !exit && !drinkPotion && !search) {
    return {
      intent: "unclear",
      summary: "",
      clarification:
        "I couldn't find a move in that. Try something like “attack the rat”, “sneak past and go east”, “drink a potion” or “search the room”.",
      source: "heuristic",
    };
  }

  const move: DndTurnInput = { action, exit, drinkPotion, search, rolls };
  const bits: string[] = [];
  if (action !== "none") bits.push(action.charAt(0).toUpperCase() + action.slice(1));
  if (drinkPotion) bits.push("drink a potion");
  if (search) bits.push("search the room");
  if (exit) bits.push(`go ${exit}`);
  move.summary = `${bits.join(", ")}.`.replace(/^./, (c) => c.toUpperCase());
  return { intent: "move", move, summary: move.summary, source: "heuristic" };
}
