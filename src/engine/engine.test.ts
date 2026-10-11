import { describe, expect, it } from "vitest";
import { applyCharacterSheet, applyMove } from "./engine";
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
        { id: "goblin", name: "Goblin", hp: 7, ac: 15, attack: "+4 to hit, 1d6+2", dexMod: 2, passivePerception: 9 },
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

function freshState(overrides: Partial<DndPlayState> = {}): DndPlayState {
  const character = deriveCharacter({ name: "Hero", class: "fighter", scores: {} }); // maxHp 10, ac 18
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

describe("applyCharacterSheet", () => {
  it("starts a fresh campaign at the start node with a derived character", () => {
    const { state, events } = applyCharacterSheet(testCampaign, { name: "Rowan", class: "fighter", scores: {} });
    expect(state.gameState.currentNode).toBe("start");
    expect(state.gameState.discoveredNodes).toEqual(["start"]);
    expect(state.gameState.status).toBe("active");
    expect(state.gameState.turnCount).toBe(0);
    expect(state.character.name).toBe("Rowan");
    expect(events[0]).toContain("Rowan the Fighter");
    expect(state.turnLog).toHaveLength(1);
  });
});

describe("applyMove — combat", () => {
  it("hits and damages the monster when the roll meets or beats AC", () => {
    const { state, events } = applyMove(freshState(), testCampaign, {
      diceRolls: [{ label: "to hit", total: 18 }],
      damageDealt: 5,
    });
    expect(state.gameState.monsterHp.goblin).toBe(2);
    expect(events.some((e) => e.includes("Hit Goblin for 5"))).toBe(true);
    expect(state.gameState.defeatedMonsters).not.toContain("goblin");
  });

  it("misses when the to-hit roll is below AC, and deals no damage", () => {
    const { state, events } = applyMove(freshState(), testCampaign, {
      diceRolls: [{ label: "to hit", total: 10 }],
      damageDealt: 5,
    });
    expect(state.gameState.monsterHp.goblin ?? 7).toBe(7);
    expect(events.some((e) => e.includes("Missed Goblin"))).toBe(true);
  });

  it("marks the monster defeated at 0 HP and allows movement through the cleared room", () => {
    const { state, events } = applyMove(freshState(), testCampaign, {
      diceRolls: [{ label: "to hit", total: 18 }],
      damageDealt: 10,
      chosenExit: "north",
    });
    expect(state.gameState.defeatedMonsters).toContain("goblin");
    expect(events.some((e) => e.includes("Goblin defeated!"))).toBe(true);
    expect(state.gameState.currentNode).toBe("goal");
    // Reaching the (now-cleared) goal room ends the campaign in victory.
    expect(state.gameState.status).toBe("won");
    expect(events.some((e) => e.includes("Victory"))).toBe(true);
  });

  it("blocks movement while a living monster still occupies the room", () => {
    const { state, events } = applyMove(freshState(), testCampaign, { chosenExit: "north" });
    expect(state.gameState.currentNode).toBe("start");
    expect(events.some((e) => e.includes("Enemies still block the way"))).toBe(true);
  });

  it("reports an invalid exit without moving", () => {
    const state = freshState({
      gameState: {
        currentNode: "goal",
        discoveredNodes: ["start", "goal"],
        defeatedMonsters: [],
        monsterHp: {},
        searchedNodes: [],
        combat: { node: null, playerFirst: null },
        status: "active",
        turnCount: 0,
      },
    });
    const { state: next, events } = applyMove(state, testCampaign, { chosenExit: "west" });
    expect(next.gameState.currentNode).toBe("goal");
    expect(events.some((e) => e.includes('no "west" exit'))).toBe(true);
  });
});

describe("applyMove — sneak / flee / dodge", () => {
  it("succeeds a sneak past when the stealth roll beats passive perception", () => {
    const { state, events } = applyMove(freshState(), testCampaign, {
      checkboxesMarked: ["Sneak"],
      stealthRoll: 15, // beats passive perception 9
      chosenExit: "north",
    });
    expect(events.some((e) => e.includes("You move unseen"))).toBe(true);
    expect(state.gameState.currentNode).toBe("goal");
  });

  it("takes damage when a sneak attempt is spotted", () => {
    const { state, events } = applyMove(freshState(), testCampaign, {
      checkboxesMarked: ["Sneak"],
      stealthRoll: 3, // below passive perception 9
      damageTaken: 4,
    });
    expect(events.some((e) => e.includes("You are spotted"))).toBe(true);
    expect(state.character.currentHp).toBe(state.character.maxHp - 4);
  });

  it("flees and takes an opportunity hit, then moves", () => {
    const { state, events } = applyMove(freshState(), testCampaign, {
      checkboxesMarked: ["Flee"],
      damageTaken: 3,
      chosenExit: "north",
    });
    expect(events.some((e) => e.includes("You took 3 damage as you turn to run"))).toBe(true);
    expect(state.gameState.currentNode).toBe("goal");
  });

  it("dodges and still takes reduced-narrative damage from the recorded roll", () => {
    const { state, events } = applyMove(freshState(), testCampaign, {
      checkboxesMarked: ["Dodge"],
      damageTaken: 2,
    });
    expect(events.some((e) => e.includes("Dodge action"))).toBe(true);
    expect(state.character.currentHp).toBe(state.character.maxHp - 2);
  });

  it("warns and applies only the higher-priority action when Attack and Dodge are both marked", () => {
    const { state, events } = applyMove(freshState(), testCampaign, {
      checkboxesMarked: ["Attack", "Dodge"],
      diceRolls: [{ label: "to hit", total: 18 }],
      damageDealt: 4,
    });
    expect(events.some((e) => e.includes("You marked Dodge and Attack") && e.includes("only Dodge was applied"))).toBe(
      true,
    );
    expect(events.some((e) => e.includes("Dodge action"))).toBe(true);
    expect(events.some((e) => e.includes("Hit Goblin"))).toBe(false);
    expect(state.gameState.monsterHp.goblin ?? 7).toBe(7);
  });
});

describe("applyMove — potions and search", () => {
  it("heals on a marked potion with a heal roll, capped at max HP, and consumes it", () => {
    const hurt = freshState();
    hurt.character.currentHp = 4;
    const { state, events } = applyMove(hurt, testCampaign, {
      checkboxesMarked: ["Potion"],
      healAmount: 20, // overheal, should clamp
    });
    expect(state.character.currentHp).toBe(state.character.maxHp);
    expect(state.character.inventory.some((i) => i.toLowerCase().includes("potion"))).toBe(false);
    expect(events.some((e) => e.includes("recover"))).toBe(true);
  });

  it("reports no potions left when the inventory has none", () => {
    const noPotion = freshState();
    noPotion.character.inventory = noPotion.character.inventory.filter((i) => !i.toLowerCase().includes("potion"));
    const { events } = applyMove(noPotion, testCampaign, { checkboxesMarked: ["Potion"], healAmount: 5 });
    expect(events.some((e) => e.includes("have none left"))).toBe(true);
  });

  it("finds loot on a successful Perception check, and nothing new on a second search", () => {
    // Clear the goblin first so damage-taken side effects don't interfere with the assertion.
    let state = freshState();
    state.gameState.monsterHp.goblin = 0;
    state.gameState.defeatedMonsters = ["goblin"];

    const first = applyMove(state, testCampaign, { checkboxesMarked: ["Search"], perceptionRoll: 15 });
    expect(first.state.character.inventory).toContain("Shiny Coin");
    expect(first.events.some((e) => e.includes("find: Shiny Coin"))).toBe(true);
    expect(first.state.gameState.searchedNodes).toContain("start");

    const second = applyMove(first.state, testCampaign, { checkboxesMarked: ["Search"], perceptionRoll: 15 });
    expect(second.events.some((e) => e.includes("nothing new"))).toBe(true);
  });

  it("finds nothing on a failed Perception check, but still consumes the search", () => {
    const state = freshState();
    state.gameState.monsterHp.goblin = 0;
    state.gameState.defeatedMonsters = ["goblin"];

    const { state: next, events } = applyMove(state, testCampaign, { checkboxesMarked: ["Search"], perceptionRoll: 5 });
    expect(next.character.inventory).not.toContain("Shiny Coin");
    expect(next.gameState.searchedNodes).toContain("start");
    expect(events.some((e) => e.includes("don't find anything"))).toBe(true);
  });

  it("prompts for a Perception roll and doesn't consume the search when none was read", () => {
    const state = freshState();
    state.gameState.monsterHp.goblin = 0;
    state.gameState.defeatedMonsters = ["goblin"];

    const { state: next, events } = applyMove(state, testCampaign, { checkboxesMarked: ["Search"] });
    expect(next.gameState.searchedNodes).not.toContain("start");
    expect(events.some((e) => e.includes("no Perception roll was read"))).toBe(true);
  });
});

describe("applyMove — death", () => {
  it("ends the campaign when HP drops to zero or below", () => {
    const state = freshState();
    const { state: next, events } = applyMove(state, testCampaign, { damageTaken: 999 });
    expect(next.character.currentHp).toBe(0);
    expect(next.gameState.status).toBe("dead");
    expect(events.some((e) => e.includes("You have fallen"))).toBe(true);
  });
});

describe("applyMove — initiative", () => {
  it("records who acts first and only resolves it once per encounter", () => {
    const first = applyMove(freshState(), testCampaign, { initiativeRoll: 15 });
    expect(first.state.gameState.combat.playerFirst).toBe(true); // 15 >= monster init (10 + dexMod 2 = 12)
    expect(first.events.some((e) => e.includes("you act first"))).toBe(true);

    // A second initiative roll in the same encounter (same node) doesn't re-resolve.
    const second = applyMove(first.state, testCampaign, { initiativeRoll: 1 });
    expect(second.state.gameState.combat.playerFirst).toBe(true);
    expect(second.events.some((e) => e.includes("Initiative:"))).toBe(false);
  });
});
