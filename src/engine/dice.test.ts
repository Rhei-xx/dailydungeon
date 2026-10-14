import { describe, expect, it } from "vitest";
import { parseDice, roll4d6DropLowest, rollD20, rollDice, scriptedDice, seededDice } from "./dice";

describe("parseDice", () => {
  it("parses count, sides and modifier in the usual spellings", () => {
    expect(parseDice("1d8+3")).toEqual({ count: 1, sides: 8, modifier: 3 });
    expect(parseDice("2d4 + 2")).toEqual({ count: 2, sides: 4, modifier: 2 });
    expect(parseDice("d20-1")).toEqual({ count: 1, sides: 20, modifier: -1 });
    expect(parseDice("1D12")).toEqual({ count: 1, sides: 12, modifier: 0 });
  });

  it("rejects garbage and out-of-range dice", () => {
    expect(() => parseDice("a sword")).toThrow(/Not a dice expression/);
    expect(() => parseDice("0d6")).toThrow(/out of range/);
    expect(() => parseDice("1d1")).toThrow(/out of range/);
  });
});

describe("rollDice", () => {
  it("sums the faces and the modifier", () => {
    const r = rollDice(scriptedDice([3, 4]), "2d4+2");
    expect(r).toEqual({ expr: "2d4+2", dice: [3, 4], modifier: 2, total: 9 });
  });

  it("doubles the dice, not the modifier, on a critical", () => {
    const r = rollDice(scriptedDice([5, 6]), "1d8+3", { critical: true });
    expect(r.expr).toBe("2d8+3");
    expect(r.total).toBe(14);
  });
});

describe("rollD20", () => {
  it("keeps the higher face with advantage and the lower with disadvantage", () => {
    const adv = rollD20(scriptedDice([4, 17]), 2, "advantage");
    expect(adv).toMatchObject({ dice: [4, 17], natural: 17, total: 19 });
    expect(adv.expr).toBe("1d20+2 (advantage)");

    const dis = rollD20(scriptedDice([4, 17]), 2, "disadvantage");
    expect(dis).toMatchObject({ natural: 4, total: 6 });
  });

  it("rolls a single die normally", () => {
    expect(rollD20(scriptedDice([11]), -1)).toMatchObject({
      expr: "1d20-1",
      dice: [11],
      natural: 11,
      total: 10,
    });
  });
});

describe("roll4d6DropLowest", () => {
  it("drops the single lowest face", () => {
    expect(roll4d6DropLowest(scriptedDice([1, 6, 3, 5])).total).toBe(14);
  });
});

describe("seededDice", () => {
  it("replays the same rolls for the same seed and differs across seeds", () => {
    const rolls = (seed: string) => {
      const dice = seededDice(seed);
      return Array.from({ length: 12 }, () => dice.die(20));
    };
    expect(rolls("campaign-1:turn-3:<abc@mail>")).toEqual(rolls("campaign-1:turn-3:<abc@mail>"));
    expect(rolls("campaign-1:turn-3:<abc@mail>")).not.toEqual(
      rolls("campaign-1:turn-4:<abc@mail>"),
    );
  });

  it("only produces faces that exist on the die, and all of them", () => {
    const dice = seededDice("range-check");
    const seen = new Set<number>();
    for (let i = 0; i < 2000; i++) seen.add(dice.die(6));
    expect([...seen].sort()).toEqual([1, 2, 3, 4, 5, 6]);
  });
});

describe("scriptedDice", () => {
  it("throws when it runs out or a face can't exist on the die", () => {
    const dice = scriptedDice([7]);
    expect(() => dice.die(6)).toThrow(/can't be rolled on a d6/);
    expect(() => scriptedDice([]).die(20)).toThrow(/ran out/);
  });
});
