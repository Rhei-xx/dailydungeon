import { Type, type Schema } from "@google/genai";
import { ABILITIES, CLASS_IDS } from "../engine/rules";
import type { DndAbility, DndAction, DndPlayerRolls, DndTurnInput } from "../engine/types";
import { stripCodeFence, type TextModel } from "./gemini";
import { heuristicParse } from "./heuristic-parse";
import {
  expectsCharacter,
  explicitlyAsksToRestart,
  type ParseContext,
  type ParsedReply,
  type ReplyIntent,
} from "./reply-types";

const INTENTS: ReplyIntent[] = ["character", "move", "restart", "unclear"];
const ACTIONS: DndAction[] = ["attack", "sneak", "flee", "dodge", "none"];
const ROLL_KEYS: (keyof DndPlayerRolls)[] = [
  "initiative",
  "toHit",
  "damage",
  "stealth",
  "perception",
  "heal",
];

const SYSTEM = `You read email replies from the single player of a solo Dungeons & Dragons game played by email, and turn each reply into a structured action for the game engine.

Rules:
- Use only what the player actually wrote. Never invent a dice total: a roll is null unless the player states a number for it (the engine rolls anything left null).
- Dice totals already include modifiers: "rolled 15 to hit" means toHit = 15.
- Pick at most one primary action (attack, sneak, flee, dodge); use "none" if they only search, drink a potion or walk through an exit.
- "exit" must be one of the listed exit directions, matched to what the player means ("climb down the rope" -> "down"); otherwise null.
- While the game is waiting for a character, read the reply as character creation: a name, a class (fighter, rogue or barbarian — map a description like "sneaky" to the closest), and any ability scores they gave. Missing pieces stay null; the dice fill them in.
- Use intent "restart" only if the player explicitly asks to restart or make a new character mid-adventure.
- Use intent "unclear" when the reply isn't a usable action (a question, chit-chat, something impossible); put a short, friendly note for the player in "clarification".
- "summary" restates the move in one short line in the second person imperative, e.g. "Attack the giant rat, then head east."`;

const ROLL_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: Object.fromEntries(
    ROLL_KEYS.map((k) => [k, { type: Type.INTEGER, nullable: true }]),
  ) as Record<string, Schema>,
};

const RESPONSE_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    intent: { type: Type.STRING, enum: INTENTS },
    summary: { type: Type.STRING },
    clarification: { type: Type.STRING, nullable: true },
    character: {
      type: Type.OBJECT,
      nullable: true,
      properties: {
        name: { type: Type.STRING, nullable: true },
        class: { type: Type.STRING, nullable: true, enum: [...CLASS_IDS] },
        scores: {
          type: Type.OBJECT,
          properties: Object.fromEntries(
            ABILITIES.map((a) => [a, { type: Type.INTEGER, nullable: true }]),
          ) as Record<string, Schema>,
        },
      },
    },
    move: {
      type: Type.OBJECT,
      nullable: true,
      properties: {
        action: { type: Type.STRING, enum: ACTIONS },
        exit: { type: Type.STRING, nullable: true },
        drinkPotion: { type: Type.BOOLEAN },
        search: { type: Type.BOOLEAN },
        rolls: ROLL_SCHEMA,
      },
    },
  },
  required: ["intent", "summary"],
};

function describeContext(ctx: ParseContext): string {
  if (expectsCharacter(ctx.status)) {
    const classes = Object.entries(ctx.classes)
      .map(([id, blurb]) => `- ${id}: ${blurb}`)
      .join("\n");
    return `Game status: waiting for the player to create a character (${ctx.status}).\nClasses:\n${classes}`;
  }
  return [
    "Game status: adventure in progress.",
    `Current room: ${ctx.roomTitle}.`,
    `Enemies here: ${ctx.monsters.length > 0 ? ctx.monsters.join(", ") : "none"}.`,
    `Exits: ${ctx.exits.length > 0 ? ctx.exits.join(", ") : "none"}.`,
    `Has a healing potion: ${ctx.hasPotion ? "yes" : "no"}.`,
  ].join("\n");
}

function str(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const clean = value.replace(/\s+/g, " ").trim();
  return clean ? clean.slice(0, max) : null;
}

function int(value: unknown, min: number, max: number): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max
    ? value
    : null;
}

const UNCLEAR_DEFAULT = "I couldn't work out what you want to do this turn.";

/**
 * Turn the model's JSON into a ParsedReply the engine can trust: every field
 * is type- and range-checked, the intent is forced to fit the game's state,
 * and "restart" needs the player to have actually said so. Pure.
 */
export function reconcileParsed(raw: unknown, ctx: ParseContext, replyText: string): ParsedReply {
  const obj = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  let intent: ReplyIntent = INTENTS.includes(obj.intent as ReplyIntent)
    ? (obj.intent as ReplyIntent)
    : "unclear";
  const summary = str(obj.summary, 200) ?? "";
  const clarification = str(obj.clarification, 300) ?? undefined;

  if (expectsCharacter(ctx.status) && intent !== "unclear") intent = "character";
  if (!expectsCharacter(ctx.status) && intent === "character") {
    return {
      intent: "unclear",
      summary,
      clarification:
        "You're in the middle of an adventure — to roll up a new character instead, reply “restart”.",
      source: "gemini",
    };
  }
  if (intent === "restart" && !explicitlyAsksToRestart(replyText)) {
    return {
      intent: "unclear",
      summary,
      clarification: "If you'd like to start over with a new character, reply “restart”.",
      source: "gemini",
    };
  }

  if (intent === "unclear") {
    return { intent, summary, clarification: clarification ?? UNCLEAR_DEFAULT, source: "gemini" };
  }
  if (intent === "restart") return { intent, summary, source: "gemini" };

  if (intent === "character") {
    const c = (obj.character && typeof obj.character === "object" ? obj.character : {}) as Record<
      string,
      unknown
    >;
    const rawScores = (c.scores && typeof c.scores === "object" ? c.scores : {}) as Record<
      string,
      unknown
    >;
    const scores: Partial<Record<DndAbility, number | null>> = {};
    for (const a of ABILITIES) scores[a] = int(rawScores[a], 1, 20);
    const cls = str(c.class, 20)?.toLowerCase() ?? null;
    return {
      intent,
      character: {
        name: str(c.name, 40),
        class: cls && (CLASS_IDS as readonly string[]).includes(cls) ? cls : null,
        scores,
      },
      summary,
      source: "gemini",
    };
  }

  const m = (obj.move && typeof obj.move === "object" ? obj.move : {}) as Record<string, unknown>;
  const rawRolls = (m.rolls && typeof m.rolls === "object" ? m.rolls : {}) as Record<
    string,
    unknown
  >;
  const rolls: DndPlayerRolls = {};
  for (const key of ROLL_KEYS) {
    const value = int(rawRolls[key], -10, 60);
    if (value != null) rolls[key] = value;
  }
  const exit = str(m.exit, 20)?.toLowerCase() ?? null;
  const move: DndTurnInput = {
    action: ACTIONS.includes(m.action as DndAction) ? (m.action as DndAction) : "none",
    // Kept even if it isn't a real exit — the engine says "there is no X
    // exit", which is better feedback than silently ignoring it.
    exit,
    drinkPotion: m.drinkPotion === true,
    search: m.search === true,
    rolls,
    summary,
  };
  if (move.action === "none" && !move.exit && !move.drinkPotion && !move.search) {
    return {
      intent: "unclear",
      summary,
      clarification: clarification ?? UNCLEAR_DEFAULT,
      source: "gemini",
    };
  }
  return { intent: "move", move, summary, source: "gemini" };
}

/**
 * Read a reply with Gemini, falling back to the keyword parser when there's
 * no model or the call fails — the daily run should never die on a parse.
 */
export async function parseReply(
  model: TextModel | null,
  replyText: string,
  ctx: ParseContext,
): Promise<ParsedReply> {
  if (!replyText.trim()) {
    return {
      intent: "unclear",
      summary: "",
      clarification: "Your reply looked empty — write your move above the quoted email.",
      source: "heuristic",
    };
  }
  if (!model) return heuristicParse(replyText, ctx);
  try {
    const raw = await model.json({
      system: SYSTEM,
      prompt: `${describeContext(ctx)}\n\nThe player's reply:\n"""\n${replyText}\n"""`,
      schema: RESPONSE_SCHEMA,
    });
    return reconcileParsed(JSON.parse(stripCodeFence(raw)), ctx, replyText);
  } catch (err) {
    console.warn(
      "parse-reply: Gemini read failed, using the keyword fallback:",
      err instanceof Error ? err.message : err,
    );
    return heuristicParse(replyText, ctx);
  }
}
