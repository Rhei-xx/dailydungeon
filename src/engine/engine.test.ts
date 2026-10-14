import { describe, expect, it } from "vitest";
import { scriptedDice } from "./dice";
import { applyCharacterSheet, applyTurn, awaitingCharacterState } from "./engine";
import { deriveCharacter } from "./rules";
import type { DndCampaignDefinition, DndPlayState } from "./types";

/** A small, fully-controlled two-room campaign — deliberately not the real
 *  built-in adventure, so combat-math assertions don't depend on its balance
 *  numbers changing later. */
const testCampaign: DndCampaignDefinition = {
  campaignName: "Test Campaign",
  schemaVersion: 1,
  grid: { cols: 2, rows: 1 },
  startNode: "start",
  goalNode: "goal",
  nodes: {
    start: {
      title: "Start Room",
      x: 0,
      y: 0,
      description: "A guarded room.",
      monsters: [
        {
          id: "goblin",
          name: "Goblin",
          hp: 7,
          ac: 15,
          attack: "+4 to hit, 1d6+2",
          toHit: 4,
          damage: "1d6+2",
          dexMod: 2, // initiative 12
          passivePerception: 9,
        },
      ],
      loot: ["Shiny Coin"],
      exits: { north: "goal" },
    },
    goal: {
      title: "Goal Room",
      x: 1,
      y: 0,
      description: "An empty vault.",
      monsters: [],
      isGoal: true,
      exits: { south: "start" },
    },
  },
};

const ALL_TENS = {
  strength: 10,
  dexterity: 10,
  constitution: 10,
  intelligence: 10,
  wisdom: 10,
  charisma: 10,
};

/** A fighter with every score at 10: HP 10, AC 18, to hit +2, damage 1d8+0,
 *  Stealth/Perception/Initiative +0. */
function freshState(overrides: Partial<DndPlayState> = {}): DndPlayState {
  const character = deriveCharacter({ name: "Hero", class: "fighter", scores: {} });
  return {
    character,
    gameState: {
      currentNode: "start",
      discoveredNodes: ["start"],
      defeatedMonsters: [],
      monsterHp: {},
      searchedNodes: [],
      combat: { node: null, playerFirst: null },
      status: "active",
      turnCount: 0,
    },
    turnLog: [],
    ...overrides,
  };
}

/** freshState with the goblin already dead, so no monster attacks happen. */
function clearedState(): DndPlayState {
  const state = freshState();
  state.gameState.monsterHp.goblin = 0;
  state.gameState.defeatedMonsters = ["goblin"];
  return state;
}

describe("awaitingCharacterState", () => {
  it("starts at the first room, waiting for a character", () => {
    const state = awaitingCharacterState(testCampaign);
    expect(state.gameState.status).toBe("awaiting_character");
    expect(state.gameState.currentNode).toBe("start");
    expect(state.turnLog).toEqual([]);
  });
});

describe("applyCharacterSheet", () => {
  it("starts a fresh campaign at the start node with a derived character", () => {
    const dice = scriptedDice([]);
    const { state, events, rolls } = applyCharacterSheet(
      testCampaign,
      { name: "Rowan", class: "fighter", scores: ALL_TENS },
      dice,
    );
    expect(state.gameState.currentNode).toBe("start");
    expect(state.gameState.discoveredNodes).toEqual(["start"]);
    expect(state.gameState.status).toBe("active");
    expect(state.gameState.turnCount).toBe(0);
    expect(state.character.name).toBe("Rowan");
    expect(events[0]).toContain("Rowan the Fighter");
    expect(state.turnLog).toHaveLength(1);
    expect(rolls).toEqual([]);
  });

  it("fills a missing class and every missing ability score from the dice", () => {
    const abilityRolls = [
      [6, 6, 6, 1], // STR 18
      [5, 5, 5, 1], // DEX 15
      [4, 4, 4, 1], // CON 12
      [3, 3, 3, 1], // INT 9
      [2, 2, 2, 1], // WIS 6
      [1, 1, 1, 1], // CHA 3
    ];
    const dice = scriptedDice([2 /* class: d3 → rogue */, ...abilityRolls.flat()]);
    const { state, events, rolls } = applyCharacterSheet(testCampaign, { name: "Vex" }, dice);
    expect(state.character.class).toBe("Rogue");
    expect(state.character.scores).toEqual({
      strength: 18,
      dexterity: 15,
      constitution: 12,
      intelligence: 9,
      wisdom: 6,
      charisma: 3,
    });
    expect(rolls.map((r) => r.label)).toEqual(["STR", "DEX", "CON", "INT", "WIS", "CHA"]);
    expect(events).toContain("The dice chose your class: Rogue.");
    expect(events.some((e) => e.includes("Rolled all six ability scores"))).toBe(true);
    expect(dice.remaining()).toBe(0);
  });

  it("keeps the scores the player gave and only rolls the missing ones", () => {
    const { charisma: _omit, ...fiveScores } = ALL_TENS;
    const dice = scriptedDice([6, 6, 6, 6]);
    const { state, rolls, events } = applyCharacterSheet(
      testCampaign,
      { name: "Krag", class: "barbarian", scores: { ...fiveScores, strength: 16 } },
      dice,
    );
    expect(state.character.scores.strength).toBe(16);
    expect(state.character.scores.charisma).toBe(18);
    expect(rolls.map((r) => r.label)).toEqual(["CHA"]);
    expect(events.some((e) => e.includes("Rolled CHA"))).toBe(true);
  });
});

describe("applyTurn — attacking", () => {
  it("uses the player's own to-hit and damage totals, then the monster swings back", () => {
    const dice = scriptedDice([15, 5]); // initiative 15 (vs 12: you first); goblin attack 5+4=9 vs AC 18
    const { state, events, rolls } = applyTurn(
      freshState(),
      testCampaign,
      { action: "attack", rolls: { toHit: 18, damage: 5 } },
      dice,
    );
    expect(state.gameState.monsterHp.goblin).toBe(2);
    expect(events.some((e) => e.includes("Hit Goblin for 5"))).toBe(true);
    expect(events).toContain("Goblin attacks and misses.");
    expect(rolls.find((r) => r.label === "To hit (Goblin)")).toMatchObject({
      by: "you",
      total: 18,
    });
    expect(state.character.currentHp).toBe(10);
    expect(dice.remaining()).toBe(0);
  });

  it("misses when the to-hit total is below AC, and deals no damage", () => {
    const { state, events } = applyTurn(
      freshState(),
      testCampaign,
      { action: "attack", rolls: { toHit: 10, damage: 5 } },
      scriptedDice([15, 5]),
    );
    expect(state.gameState.monsterHp.goblin).toBe(7);
    expect(events.some((e) => e.includes("Missed Goblin"))).toBe(true);
  });

  it("rolls to-hit and damage with the player's bonuses when none are given", () => {
    // initiative 15; to hit 13+2=15 vs AC 15 (hit); damage 1d8 → 6;
    // goblin attack 14+4=18 vs AC 18 (hit); goblin damage 1d6+2 → 3+2=5
    const dice = scriptedDice([15, 13, 6, 14, 3]);
    const { state, events, rolls } = applyTurn(
      freshState(),
      testCampaign,
      { action: "attack" },
      dice,
    );
    expect(state.gameState.monsterHp.goblin).toBe(1);
    expect(rolls.find((r) => r.label === "To hit (Goblin)")).toMatchObject({
      by: "dice",
      expr: "1d20+2",
      total: 15,
      outcome: "vs AC 15 — hit",
    });
    expect(rolls.find((r) => r.label === "Damage")).toMatchObject({
      by: "dice",
      expr: "1d8",
      total: 6,
    });
    expect(events).toContain("Goblin hits you for 5 (HP 5/10).");
    expect(state.character.currentHp).toBe(5);
    expect(dice.remaining()).toBe(0);
  });

  it("treats a natural 20 as a critical hit that doubles the damage dice", () => {
    const dice = scriptedDice([15, 20, 4, 4]); // initiative; nat 20; 2d8 → 8 kills the goblin
    const { state, events } = applyTurn(freshState(), testCampaign, { action: "attack" }, dice);
    expect(events.some((e) => e.startsWith("Critical hit! Hit Goblin for 8"))).toBe(true);
    expect(state.gameState.defeatedMonsters).toContain("goblin");
    expect(
      events.some((e) => e.includes("cleared the room before anything could swing back")),
    ).toBe(true);
    expect(dice.remaining()).toBe(0);
  });

  it("treats a natural 1 as a miss", () => {
    const { state, events } = applyTurn(
      freshState(),
      testCampaign,
      { action: "attack" },
      scriptedDice([15, 1, 5]),
    );
    expect(state.gameState.monsterHp.goblin).toBe(7);
    expect(events.some((e) => e.includes("Missed Goblin"))).toBe(true);
  });

  it("marks the monster defeated at 0 HP and allows movement through the cleared room", () => {
    const { state, events } = applyTurn(
      freshState(),
      testCampaign,
      { action: "attack", exit: "north", rolls: { toHit: 18, damage: 10 } },
      scriptedDice([15]),
    );
    expect(state.gameState.defeatedMonsters).toContain("goblin");
    expect(events.some((e) => e.includes("Goblin defeated!"))).toBe(true);
    expect(state.gameState.currentNode).toBe("goal");
    // Reaching the (now-cleared) goal room ends the campaign in victory.
    expect(state.gameState.status).toBe("won");
    expect(events.some((e) => e.includes("Victory"))).toBe(true);
  });

  it("lets a monster that won initiative swing even if you drop it this turn", () => {
    // initiative 3 vs 12 (enemy first); goblin attack 14+4=18 hits; damage 1+2=3
    const { state, events } = applyTurn(
      freshState(),
      testCampaign,
      { action: "attack", rolls: { toHit: 18, damage: 10 } },
      scriptedDice([3, 14, 1]),
    );
    expect(events.some((e) => e.includes("Goblin defeated!"))).toBe(true);
    expect(events).toContain("Goblin hits you for 3 (HP 7/10).");
    expect(state.character.currentHp).toBe(7);
  });

  it("resolves initiative only once per encounter", () => {
    // Turn 1: player-given initiative 15; goblin attacks at disadvantage (18, 3 → 3+4=7, miss).
    const first = applyTurn(
      freshState(),
      testCampaign,
      { action: "dodge", rolls: { initiative: 15 } },
      scriptedDice([18, 3]),
    );
    expect(first.state.gameState.combat.playerFirst).toBe(true);
    expect(first.events.some((e) => e.includes("you act first"))).toBe(true);

    const second = applyTurn(
      first.state,
      testCampaign,
      { action: "dodge", rolls: { initiative: 1 } },
      scriptedDice([2, 2]),
    );
    expect(second.state.gameState.combat.playerFirst).toBe(true);
    expect(second.events.some((e) => e.includes("Initiative:"))).toBe(false);
  });

  it("says so when there's nothing left to fight", () => {
    const { events } = applyTurn(
      clearedState(),
      testCampaign,
      { action: "attack" },
      scriptedDice([]),
    );
    expect(events).toContain("There's nothing left to fight here.");
  });
});

describe("applyTurn — movement", () => {
  it("blocks movement while a living monster still occupies the room", () => {
    const { state, events } = applyTurn(
      freshState(),
      testCampaign,
      { action: "none", exit: "north" },
      scriptedDice([5]),
    );
    expect(state.gameState.currentNode).toBe("start");
    expect(events.some((e) => e.includes("Enemies still block the way"))).toBe(true);
  });

  it("reports an invalid exit without moving", () => {
    const state = freshState();
    state.gameState.currentNode = "goal";
    state.gameState.discoveredNodes = ["start", "goal"];
    const { state: next, events } = applyTurn(
      state,
      testCampaign,
      { action: "none", exit: "west" },
      scriptedDice([]),
    );
    expect(next.gameState.currentNode).toBe("goal");
    expect(events.some((e) => e.includes('no "west" exit'))).toBe(true);
  });
});

describe("applyTurn — sneak / flee / dodge", () => {
  it("sneaks past when the player's Stealth total beats passive Perception", () => {
    const { state, events } = applyTurn(
      freshState(),
      testCampaign,
      { action: "sneak", exit: "north", rolls: { stealth: 15 } },
      scriptedDice([]),
    );
    expect(events.some((e) => e.includes("You move unseen"))).toBe(true);
    expect(state.gameState.currentNode).toBe("goal");
  });

  it("rolls Stealth when none is given; being spotted lets every monster attack", () => {
    // stealth 5+0 vs 9 (spotted); goblin attack 16+4=20 hits; damage 4+2=6
    const { state, events } = applyTurn(
      freshState(),
      testCampaign,
      { action: "sneak" },
      scriptedDice([5, 16, 4]),
    );
    expect(events.some((e) => e.includes("You are spotted"))).toBe(true);
    expect(state.character.currentHp).toBe(4);
  });

  it("flees through an exit after taking the opportunity attack", () => {
    const { state, events } = applyTurn(
      freshState(),
      testCampaign,
      { action: "flee", exit: "north" },
      scriptedDice([2]),
    );
    expect(events).toContain("Goblin attacks and misses.");
    expect(events.some((e) => e.includes("You flee north to Goal Room"))).toBe(true);
    expect(state.gameState.currentNode).toBe("goal");
  });

  it("flees through the only exit when none is named", () => {
    const { state } = applyTurn(freshState(), testCampaign, { action: "flee" }, scriptedDice([2]));
    expect(state.gameState.currentNode).toBe("goal");
  });

  it("gives attackers disadvantage when dodging", () => {
    const { events, rolls } = applyTurn(
      freshState(),
      testCampaign,
      { action: "dodge" },
      scriptedDice([19, 4]),
    );
    expect(events.some((e) => e.includes("Dodge action"))).toBe(true);
    expect(rolls[0]).toMatchObject({
      label: "Goblin attacks",
      expr: "1d20+4 (disadvantage)",
      total: 8,
    });
    expect(events).toContain("Goblin attacks and misses.");
  });
});

describe("applyTurn — potions and search", () => {
  it("heals by the player's own total, capped at max HP, and consumes the potion", () => {
    const hurt = clearedState();
    hurt.character.currentHp = 4;
    const { state, events } = applyTurn(
      hurt,
      testCampaign,
      { action: "none", drinkPotion: true, rolls: { heal: 20 } },
      scriptedDice([]),
    );
    expect(state.character.currentHp).toBe(state.character.maxHp);
    expect(state.character.inventory.some((i) => i.toLowerCase().includes("potion"))).toBe(false);
    expect(events.some((e) => e.includes("recover"))).toBe(true);
  });

  it("rolls 2d4+2 for the potion when no total is given", () => {
    const hurt = clearedState();
    hurt.character.currentHp = 1;
    const { state, events } = applyTurn(
      hurt,
      testCampaign,
      { action: "none", drinkPotion: true },
      scriptedDice([3, 4]),
    );
    expect(state.character.currentHp).toBe(10);
    expect(events).toContain("You drink a potion and recover 9 HP (now 10/10).");
  });

  it("keeps the potion when already at full health", () => {
    const { state, events } = applyTurn(
      clearedState(),
      testCampaign,
      { action: "none", drinkPotion: true },
      scriptedDice([]),
    );
    expect(state.character.inventory.some((i) => i.toLowerCase().includes("potion"))).toBe(true);
    expect(events.some((e) => e.includes("already at full health"))).toBe(true);
  });

  it("reports no potions left when the inventory has none", () => {
    const noPotion = clearedState();
    noPotion.character.currentHp = 3;
    noPotion.character.inventory = noPotion.character.inventory.filter(
      (i) => !i.toLowerCase().includes("potion"),
    );
    const { events } = applyTurn(
      noPotion,
      testCampaign,
      { action: "none", drinkPotion: true },
      scriptedDice([]),
    );
    expect(events.some((e) => e.includes("have none left"))).toBe(true);
  });

  it("finds loot on a successful Perception check, and nothing new on a second search", () => {
    const first = applyTurn(
      clearedState(),
      testCampaign,
      { action: "none", search: true, rolls: { perception: 15 } },
      scriptedDice([]),
    );
    expect(first.state.character.inventory).toContain("Shiny Coin");
    expect(first.events.some((e) => e.includes("find: Shiny Coin"))).toBe(true);
    expect(first.state.gameState.searchedNodes).toContain("start");

    const second = applyTurn(
      first.state,
      testCampaign,
      { action: "none", search: true },
      scriptedDice([]),
    );
    expect(second.events.some((e) => e.includes("nothing new"))).toBe(true);
  });

  it("rolls Perception when none is given, and a failed check still uses up the search", () => {
    const { state, events, rolls } = applyTurn(
      clearedState(),
      testCampaign,
      { action: "none", search: true },
      scriptedDice([5]),
    );
    expect(state.character.inventory).not.toContain("Shiny Coin");
    expect(state.gameState.searchedNodes).toContain("start");
    expect(events.some((e) => e.includes("don't find anything"))).toBe(true);
    expect(rolls[0]).toMatchObject({
      label: "Perception (search)",
      by: "dice",
      outcome: "vs DC 12 — fail",
    });
  });
});

describe("applyTurn — death and bookkeeping", () => {
  it("ends the campaign when HP drops to zero", () => {
    const state = freshState();
    state.character.currentHp = 1;
    const { state: next, events } = applyTurn(
      state,
      testCampaign,
      { action: "none" },
      scriptedDice([15, 1]),
    );
    expect(next.character.currentHp).toBe(0);
    expect(next.gameState.status).toBe("dead");
    expect(events.some((e) => e.includes("You have fallen"))).toBe(true);
  });

  it("logs the turn with the parser's summary", () => {
    const { state } = applyTurn(
      clearedState(),
      testCampaign,
      { action: "none", search: true, rolls: { perception: 15 }, summary: "Search the room." },
      scriptedDice([]),
    );
    expect(state.gameState.turnCount).toBe(1);
    expect(state.turnLog.at(-1)).toMatchObject({ turn: 1, read: "Search the room." });
  });
});
