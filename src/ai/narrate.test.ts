import { describe, expect, it, vi } from "vitest";
import type { TextModel } from "./gemini";
import { cleanNarration, narrate, type NarrationInput } from "./narrate";

const input: NarrationInput = {
  characterName: "Brakka",
  characterClass: "Barbarian",
  fromRoom: "The Tower Entry",
  toRoom: "The Tower Entry",
  toRoomDescription: "Rubble and old leaves cover the ground.",
  move: "Attack the giant rat.",
  events: ["Hit Giant Rat for 9 (rolled 17 vs AC 12).", "Giant Rat defeated!"],
  outcome: "ongoing",
};

function model(text: string | Error): TextModel {
  return {
    json: vi.fn(),
    text: vi.fn(async () => {
      if (text instanceof Error) throw text;
      return text;
    }),
  };
}

describe("narrate", () => {
  it("uses the model's prose, cleaned up", async () => {
    const out = await narrate(model('"Your **axe** falls — the rat is no more."'), input);
    expect(out).toEqual({ text: "Your axe falls — the rat is no more.", source: "gemini" });
  });

  it("falls back to the engine's sentences without a model, on error, or on empty output", async () => {
    const plain = "Hit Giant Rat for 9 (rolled 17 vs AC 12). Giant Rat defeated!";
    expect(await narrate(null, input)).toEqual({ text: plain, source: "fallback" });
    expect(await narrate(model(new Error("timeout")), input)).toEqual({
      text: plain,
      source: "fallback",
    });
    expect(await narrate(model("   "), input)).toEqual({ text: plain, source: "fallback" });
  });
});

describe("cleanNarration", () => {
  it("strips markdown and wrapping quotes, and caps length", () => {
    expect(cleanNarration("# Title\n*You* win.")).toBe("Title\nYou win.");
    expect(cleanNarration("“Quoted.”")).toBe("Quoted.");
    expect(cleanNarration("x".repeat(2000)).length).toBeLessThanOrEqual(1201);
  });
});
