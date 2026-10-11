import { describe, expect, it, vi } from "vitest";
import { SUNKEN_VAULT_CAMPAIGN } from "../engine/campaign";
import { applyCharacterSheet } from "../engine/engine";
import { scriptedDice } from "../engine/dice";
import type { TextModel } from "./gemini";
import { parseReply, reconcileParsed } from "./parse-reply";
import { buildParseContext, type ParseContext } from "./reply-types";

const ALL_TENS = {
  strength: 10,
  dexterity: 10,
  constitution: 10,
  intelligence: 10,
  wisdom: 10,
  charisma: 10,
};

/** In the Tower Entry with two rats and three exits, like turn 2 of a real game. */
function activeContext(): ParseContext {
  const { state } = applyCharacterSheet(
    SUNKEN_VAULT_CAMPAIGN,
    { name: "Brakka", class: "barbarian", scores: ALL_TENS },
    scriptedDice([]),
  );
  state.gameState.currentNode = "tower_entry";
  return buildParseContext(state, SUNKEN_VAULT_CAMPAIGN);
}

const awaiting: ParseContext = { ...activeContext(), status: "awaiting_character" };

function fakeModel(response: string | Error): TextModel & { json: ReturnType<typeof vi.fn> } {
  return {
    json: vi.fn(async () => {
      if (response instanceof Error) throw response;
      return response;
    }),
    text: vi.fn(),
  };
}

describe("buildParseContext", () => {
  it("lists the room's living monsters, exits and potion", () => {
    expect(activeContext()).toMatchObject({
      status: "active",
      roomTitle: "The Tower Entry",
      monsters: ["Giant Rat", "Giant Rat"],
      exits: ["north", "east", "west"],
      hasPotion: true,
    });
  });
});

describe("reconcileParsed", () => {
  const ctx = activeContext();

  it("keeps a valid move and range-checks the rolls", () => {
    const parsed = reconcileParsed(
      {
        intent: "move",
        summary: "Attack the rat.",
        move: {
          action: "attack",
          exit: "East",
          drinkPotion: false,
          search: false,
          rolls: { toHit: 17, damage: 999, stealth: 4.5 },
        },
      },
      ctx,
      "attack! 17 to hit",
    );
    expect(parsed.intent).toBe("move");
    expect(parsed.move).toMatchObject({ action: "attack", exit: "east", rolls: { toHit: 17 } });
    expect(parsed.move?.rolls).not.toHaveProperty("damage");
    expect(parsed.move?.rolls).not.toHaveProperty("stealth");
  });

  it("falls back to 'none' for an unknown action and to unclear when nothing is left", () => {
    expect(
      reconcileParsed(
        { intent: "move", summary: "", move: { action: "cast fireball" } },
        ctx,
        "fireball",
      ).intent,
    ).toBe("unclear");
    const walk = reconcileParsed(
      { intent: "move", summary: "", move: { action: "dance", exit: "north" } },
      ctx,
      "x",
    );
    expect(walk.move?.action).toBe("none");
  });

  it("treats garbage as unclear with a default note", () => {
    const parsed = reconcileParsed("nonsense", ctx, "hello?");
    expect(parsed).toMatchObject({
      intent: "unclear",
      clarification: expect.stringContaining("couldn't work out"),
    });
  });

  it("only restarts when the player literally asked to", () => {
    expect(
      reconcileParsed({ intent: "restart", summary: "" }, ctx, "I give up, restart").intent,
    ).toBe("restart");
    const guarded = reconcileParsed({ intent: "restart", summary: "" }, ctx, "this is going badly");
    expect(guarded).toMatchObject({
      intent: "unclear",
      clarification: expect.stringContaining("restart"),
    });
  });

  it("reads every reply as character creation while waiting for a character", () => {
    const parsed = reconcileParsed(
      {
        intent: "move",
        summary: "Brakka the barbarian",
        character: { name: "Brakka", class: "Barbarian", scores: { strength: 16, wisdom: 25 } },
      },
      awaiting,
      "Brakka, barbarian, STR 16",
    );
    expect(parsed.intent).toBe("character");
    expect(parsed.character).toMatchObject({
      name: "Brakka",
      class: "barbarian",
      scores: { strength: 16, wisdom: null },
    });
  });

  it("refuses character creation mid-adventure", () => {
    const parsed = reconcileParsed(
      { intent: "character", summary: "", character: { name: "X" } },
      ctx,
      "I'm X",
    );
    expect(parsed.intent).toBe("unclear");
  });
});

describe("parseReply", () => {
  const ctx = activeContext();

  it("uses the model's JSON, even inside a code fence", async () => {
    const model = fakeModel(
      '```json\n{"intent":"move","summary":"Sneak east.","move":{"action":"sneak","exit":"east","drinkPotion":false,"search":false,"rolls":{}}}\n```',
    );
    const parsed = await parseReply(model, "sneak past them to the east", ctx);
    expect(parsed).toMatchObject({
      intent: "move",
      source: "gemini",
      move: { action: "sneak", exit: "east" },
    });
    expect(model.json.mock.calls[0][0].prompt).toContain("Exits: north, east, west");
  });

  it("falls back to the keyword parser when the model fails", async () => {
    const parsed = await parseReply(fakeModel(new Error("quota")), "attack the rat", ctx);
    expect(parsed).toMatchObject({
      intent: "move",
      source: "heuristic",
      move: { action: "attack" },
    });
  });

  it("doesn't call the model for an empty reply", async () => {
    const model = fakeModel("{}");
    expect((await parseReply(model, "   ", ctx)).intent).toBe("unclear");
    expect(model.json).not.toHaveBeenCalled();
  });
});
