import { describe, expect, it } from "vitest";
import { CLASS_SUMMARIES } from "../engine/rules";
import { heuristicParse } from "./heuristic-parse";
import type { ParseContext } from "./reply-types";

const ctx: ParseContext = {
  status: "active",
  roomTitle: "The Tower Entry",
  monsters: ["Giant Rat"],
  exits: ["north", "east", "west"],
  hasPotion: true,
  classes: CLASS_SUMMARIES,
};

describe("heuristicParse — moves", () => {
  it("reads an attack with the player's own totals", () => {
    const parsed = heuristicParse("I attack the rat! 15 to hit, damage 7", ctx);
    expect(parsed.move).toMatchObject({
      action: "attack",
      exit: null,
      rolls: { toHit: 15, damage: 7 },
    });
    expect(parsed.summary).toBe("Attack.");
  });

  it("reads sneaking out through an exit, with a stealth roll", () => {
    const parsed = heuristicParse("Sneak past and go east, stealth: 14", ctx);
    expect(parsed.move).toMatchObject({ action: "sneak", exit: "east", rolls: { stealth: 14 } });
  });

  it("reads potion + search without a combat action", () => {
    const parsed = heuristicParse("drink a potion and search the room", ctx);
    expect(parsed.move).toMatchObject({ action: "none", drinkPotion: true, search: true });
    expect(parsed.summary).toBe("Drink a potion, search the room.");
  });

  it("only restarts when asked to", () => {
    expect(heuristicParse("restart please", ctx).intent).toBe("restart");
  });

  it("says unclear rather than guessing", () => {
    expect(heuristicParse("hmm, what should I do?", ctx)).toMatchObject({
      intent: "unclear",
      clarification: expect.stringContaining("attack the rat"),
    });
  });
});

describe("heuristicParse — character creation", () => {
  const awaiting = { ...ctx, status: "awaiting_character" as const };

  it("reads 'Name, class' and any scores given", () => {
    const parsed = heuristicParse("Brakka, barbarian. STR 16 CON 15", awaiting);
    expect(parsed.intent).toBe("character");
    expect(parsed.character).toMatchObject({
      name: "Brakka",
      class: "barbarian",
      scores: { strength: 16, constitution: 15, dexterity: null },
    });
  });

  it("leaves class and name to the dice when they aren't given", () => {
    const parsed = heuristicParse("surprise me", { ...ctx, status: "dead" });
    expect(parsed.character).toMatchObject({ name: null, class: null });
  });

  it("reads 'my name is'", () => {
    expect(heuristicParse("My name is Vex and I'm a rogue", awaiting).character).toMatchObject({
      name: "Vex",
      class: "rogue",
    });
  });
});
