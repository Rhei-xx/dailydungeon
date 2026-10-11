import { createHash } from "node:crypto";

/**
 * Anything that can roll a single die. The engine never calls Math.random —
 * every roll goes through this, so a turn is reproducible from its seed (a
 * re-run of the same reply replays the same dice) and tests can script the
 * exact faces they need.
 */
export interface Dice {
  /** A uniform integer in [1, sides]. */
  die(sides: number): number;
}

/** mulberry32 — tiny and plenty good for game dice — seeded from sha256(seed),
 *  so any string (campaign id + turn + reply Message-ID) works as a seed. */
export function seededDice(seed: string): Dice {
  let state = createHash("sha256").update(seed).digest().readUInt32LE(0);
  const next = (): number => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return { die: (sides) => 1 + Math.floor(next() * sides) };
}

/** Dice that return pre-set faces in order — for tests. Throws when it runs
 *  out or a face can't exist on the die, so a test that rolls more (or other)
 *  dice than it scripted fails loudly instead of silently passing. */
export function scriptedDice(faces: number[]): Dice & { remaining(): number } {
  const queue = [...faces];
  return {
    die(sides) {
      const face = queue.shift();
      if (face === undefined) throw new Error(`scriptedDice ran out of faces (wanted a d${sides})`);
      if (!Number.isInteger(face) || face < 1 || face > sides) {
        throw new Error(`scripted face ${face} can't be rolled on a d${sides}`);
      }
      return face;
    },
    remaining: () => queue.length,
  };
}

export interface DiceExpression {
  count: number;
  sides: number;
  modifier: number;
}

const DICE_RE = /^\s*(\d*)\s*d\s*(\d+)\s*(?:([+-])\s*(\d+))?\s*$/i;

/** Parse "1d8+3", "2d4 + 2", "d20-1". Throws on anything else. */
export function parseDice(expr: string): DiceExpression {
  const m = DICE_RE.exec(expr);
  if (!m) throw new Error(`Not a dice expression: "${expr}"`);
  const count = m[1] ? Number(m[1]) : 1;
  const sides = Number(m[2]);
  const modifier = m[3] ? (m[3] === "-" ? -1 : 1) * Number(m[4]) : 0;
  if (count < 1 || count > 100 || sides < 2 || sides > 1000) {
    throw new Error(`Dice expression out of range: "${expr}"`);
  }
  return { count, sides, modifier };
}

export function formatModifier(n: number): string {
  return n >= 0 ? `+${n}` : `${n}`;
}

export function formatDice({ count, sides, modifier }: DiceExpression): string {
  return `${count}d${sides}${modifier ? formatModifier(modifier) : ""}`;
}

export interface DiceRoll {
  /** The expression actually rolled, e.g. "2d8+3" for a critical "1d8+3". */
  expr: string;
  dice: number[];
  modifier: number;
  total: number;
}

/** Roll an expression like "1d8+3". `critical` doubles the dice (not the
 *  modifier), as in 5e. */
export function rollDice(
  dice: Dice,
  expr: string | DiceExpression,
  opts: { critical?: boolean } = {},
): DiceRoll {
  const parsed = typeof expr === "string" ? parseDice(expr) : expr;
  const rolled = { ...parsed, count: opts.critical ? parsed.count * 2 : parsed.count };
  const faces = Array.from({ length: rolled.count }, () => dice.die(rolled.sides));
  const total = faces.reduce((sum, f) => sum + f, 0) + rolled.modifier;
  return { expr: formatDice(rolled), dice: faces, modifier: rolled.modifier, total };
}

export type D20Mode = "normal" | "advantage" | "disadvantage";

export interface D20Roll {
  expr: string;
  /** Both faces when rolled with advantage/disadvantage, else one. */
  dice: number[];
  /** The face that counts — what a natural 1 / natural 20 is judged on. */
  natural: number;
  modifier: number;
  total: number;
}

export function rollD20(dice: Dice, modifier: number, mode: D20Mode = "normal"): D20Roll {
  const faces = mode === "normal" ? [dice.die(20)] : [dice.die(20), dice.die(20)];
  const natural =
    mode === "advantage"
      ? Math.max(...faces)
      : mode === "disadvantage"
        ? Math.min(...faces)
        : faces[0];
  const suffix =
    mode === "advantage" ? " (advantage)" : mode === "disadvantage" ? " (disadvantage)" : "";
  return {
    expr: `1d20${modifier ? formatModifier(modifier) : ""}${suffix}`,
    dice: faces,
    natural,
    modifier,
    total: natural + modifier,
  };
}

/** 4d6, drop the lowest — the standard 5e way to roll an ability score. */
export function roll4d6DropLowest(dice: Dice): { dice: number[]; total: number } {
  const faces = [dice.die(6), dice.die(6), dice.die(6), dice.die(6)];
  return { dice: faces, total: faces.reduce((sum, f) => sum + f, 0) - Math.min(...faces) };
}
