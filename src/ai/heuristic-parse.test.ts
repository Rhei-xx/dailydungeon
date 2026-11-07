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

  it("reads bare numbers after 'rolled' in order for the action", () => {
    expect(heuristicParse("I attack the goblin, rolled 15 and 6", ctx).move?.rolls).toEqual({
      toHit: 15,
      damage: 6,
    });
    expect(heuristicParse("Sneak past to the east, I rolled a 14", ctx).move?.rolls).toEqual({
      stealth: 14,
    });
    // A labelled number keeps its label; the bare one fills what's left.
    expect(heuristicParse("attack! rolled 9 damage and 17", ctx).move?.rolls).toEqual({
      damage: 9,
      toHit: 17,
    });
  });

  it("treats checking or taking something in the room as a search", () => {
    expect(heuristicParse("check the glint of metal", ctx).move).toMatchObject({
      action: "none",
      search: true,
    });
    expect(heuristicParse("grab the key from the muck", ctx).move?.search).toBe(true);
    expect(heuristicParse("take cover behind the rubble", ctx).move).toMatchObject({
      action: "dodge",
      search: false,
    });
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
