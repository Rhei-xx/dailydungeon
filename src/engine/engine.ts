import {
  formatModifier,
  roll4d6DropLowest,
  rollD20,
  rollDice,
  type D20Mode,
  type Dice,
} from "./dice";
import {
  ABILITIES,
  ABILITY_ABBREVIATIONS,
  CLASS_IDS,
  characterBonuses,
  deriveCharacter,
  normalizeClass,
} from "./rules";
import type {
  DndAbility,
  DndCampaignDefinition,
  DndCampaignNode,
  DndCharacterSheetInput,
  DndCombatTracker,
  DndEngineResult,
  DndGameState,
  DndMonster,
  DndPlayState,
  DndRollRecord,
  DndTurnInput,
} from "./types";

/**
 * Apply one interpreted move (or a character sheet) to campaign state. Pure
 * and deterministic given its `dice` — ported from the old repo's
 * `dnd/engine.py`. The player may roll their own dice and report totals
 * (`input.rolls`); any roll they leave out is rolled here with their
 * modifiers, and monsters always roll their own attacks. Every roll is
 * returned in `rolls` so the email can show the numbers behind the story.
 * Functions return new state rather than mutating their input.
 */

/** Flat DC for a Perception check when searching a room — deliberately one
 *  constant rather than a per-room value ("keep it simple for now"). */
const SEARCH_DC = 12;

/** Healing potion, as in 5e. */
const POTION_HEAL = "2d4+2";

function consumePotion(inventory: string[], idx: number): string[] {
  const item = inventory[idx];
  const match = /x\s*(\d+)/i.exec(item);
  const next = [...inventory];
  if (match) {
    const remaining = Number(match[1]) - 1;
    if (remaining <= 0) {
      next.splice(idx, 1);
    } else {
      next[idx] = item.replace(/x\s*\d+/i, `x${remaining}`);
    }
  } else {
    next.splice(idx, 1);
  }
  return next;
}

/** Monsters in `node` still standing, given the per-campaign HP map. */
export function livingMonsters(
  node: DndCampaignNode,
  monsterHp: Record<string, number>,
): DndMonster[] {
  return node.monsters.filter((m) => (monsterHp[m.id] ?? m.hp) > 0);
}

function ensureMonsters(node: DndCampaignNode, monsterHp: Record<string, number>): void {
  for (const m of node.monsters) {
    if (!(m.id in monsterHp)) monsterHp[m.id] = m.hp;
  }
}

export function monsterPassivePerception(m: DndMonster): number {
  return m.passivePerception ?? 10;
}

/** Deterministic "take 10" initiative for monsters — shown on the email so
 *  the player knows the number to beat. */
export function monsterInitiative(m: DndMonster): number {
  return 10 + (m.dexMod ?? 0);
}

/** Exit directions out of a room, lowercased, in campaign order. */
export function exitDirections(node: DndCampaignNode): string[] {
  return Object.keys(node.exits).map((k) => k.toLowerCase());
}

/** Move the player along an exit, discovering + seeding the destination and
 *  resetting the per-encounter combat tracker. The exit is already validated. */
function moveToExit(
  gs: DndGameState,
  campaign: DndCampaignDefinition,
  monsterHp: Record<string, number>,
  direction: string,
  events: string[],
  verb: string,
): void {
  const currentNode = campaign.nodes[gs.currentNode];
  const exits = Object.fromEntries(
    Object.entries(currentNode.exits).map(([k, v]) => [k.toLowerCase(), v]),
  );
  const dest = exits[direction];
  gs.currentNode = dest;
  if (!gs.discoveredNodes.includes(dest)) gs.discoveredNodes.push(dest);
  const destNode = campaign.nodes[dest];
  ensureMonsters(destNode, monsterHp);
  gs.combat = { node: dest, playerFirst: null };
  events.push(`${verb} ${direction} to ${destNode.title}.`);
}

/** A fresh campaign waiting on the player's first character — the shape of
 *  the old repo's state.initial.json. The placeholder hero is never shown:
 *  while status is "awaiting_character" the email asks for a character. */
export function awaitingCharacterState(campaign: DndCampaignDefinition): DndPlayState {
  return {
    character: deriveCharacter({ name: "Hero", class: "fighter", scores: {} }),
    gameState: {
      currentNode: campaign.startNode,
      discoveredNodes: [campaign.startNode],
      defeatedMonsters: [],
      monsterHp: {},
      searchedNodes: [],
      combat: { node: null, playerFirst: null },
      status: "awaiting_character",
      turnCount: 0,
    },
    turnLog: [],
  };
}

export function applyTurn(
  state: DndPlayState,
  campaign: DndCampaignDefinition,
  input: DndTurnInput,
  dice: Dice,
): DndEngineResult {
  const gs = structuredClone(state.gameState);
  const ch = structuredClone(state.character);
  const events: string[] = [];
  const rolls: DndRollRecord[] = [];
  const given = input.rolls ?? {};
  const bonus = characterBonuses(ch);

  const monsterHp = gs.monsterHp;
  const node = campaign.nodes[gs.currentNode];
  ensureMonsters(node, monsterHp);

  /** A d20 check for the player: their own total if they gave one, else rolled
   *  here with `modifier`. `natural` is only known for engine rolls. */
  function playerD20(label: string, givenTotal: number | null | undefined, modifier: number) {
    if (givenTotal != null) {
      rolls.push({ label, by: "you", total: givenTotal });
      return { total: givenTotal, natural: null as number | null };
    }
    const r = rollD20(dice, modifier);
    rolls.push({ label, by: "dice", expr: r.expr, dice: r.dice, total: r.total });
    return { total: r.total, natural: r.natural as number | null };
  }

  /** A damage/healing amount: the player's total if given, else rolled. */
  function playerAmount(
    label: string,
    givenTotal: number | null | undefined,
    expr: string,
    critical = false,
  ): number {
    if (givenTotal != null) {
      rolls.push({ label, by: "you", total: givenTotal });
      return Math.max(0, givenTotal);
    }
    const r = rollDice(dice, expr, { critical });
    rolls.push({ label, by: "dice", expr: r.expr, dice: r.dice, total: r.total });
    return Math.max(0, r.total);
  }

  const livingAtStart = livingMonsters(node, monsterHp);
  const target = livingAtStart[0] ?? null;
  let action = input.action;

  // Combat actions need something to fight; with the room clear, sneaking or
  // fleeing is just walking.
  if (!target && action === "attack") events.push("There's nothing left to fight here.");
  if (!target) action = "none";

  let exit = (input.exit ?? "").trim().toLowerCase() || null;
  const exits = exitDirections(node);
  if (exit && !exits.includes(exit)) {
    events.push(`There is no "${exit}" exit from here.`);
    exit = null;
  }
  if (action === "flee" && !exit) {
    if (exits.length === 1) {
      exit = exits[0];
    } else {
      events.push(
        "You look for a way out, but didn't say which exit to run for — name one next time.",
      );
      action = "none";
    }
  }

  // --- Initiative (resolved once per encounter, when you first attack) ------
  const combat: DndCombatTracker =
    gs.combat.node === gs.currentNode ? gs.combat : { node: gs.currentNode, playerFirst: null };
  gs.combat = combat;
  if (target && combat.playerFirst === null && (action === "attack" || given.initiative != null)) {
    const init = playerD20("Initiative", given.initiative, bonus.initiative);
    const monInit = Math.max(...livingAtStart.map(monsterInitiative));
    combat.playerFirst = init.total >= monInit;
    rolls[rolls.length - 1].outcome =
      `vs ${monInit} — ${combat.playerFirst ? "you act first" : "they act first"}`;
    const verdict = combat.playerFirst ? "you act first!" : "the enemy acts first.";
    events.push(`Initiative: ${init.total} vs ${monInit} — ${verdict}`);
  }

  // --- Your action: decides who gets to attack you this turn ----------------
  let attackers: DndMonster[] = [];
  let attackMode: D20Mode = "normal";
  let sneakSuccess = false;

  if (action === "sneak") {
    const dc = Math.max(...livingAtStart.map(monsterPassivePerception));
    const stealth = playerD20("Stealth", given.stealth, bonus.stealth);
    if (stealth.total >= dc) {
      sneakSuccess = true;
      rolls[rolls.length - 1].outcome = `vs passive Perception ${dc} — unseen`;
      events.push(`You move unseen (Stealth ${stealth.total} vs passive Perception ${dc}).`);
    } else {
      rolls[rolls.length - 1].outcome = `vs passive Perception ${dc} — spotted`;
      events.push(`You are spotted! (Stealth ${stealth.total} vs passive Perception ${dc})`);
      attackers = livingAtStart;
    }
  } else if (action === "flee") {
    events.push("You turn to run — and they lash out as you go.");
    attackers = livingAtStart; // leaving melee provokes an attack
  } else if (action === "dodge") {
    events.push("You take the Dodge action — attacks against you have disadvantage.");
    attackers = livingAtStart;
    attackMode = "disadvantage";
  } else if (action === "attack" && target) {
    const toHit = playerD20(`To hit (${target.name})`, given.toHit, bonus.toHit);
    const crit = toHit.natural === 20;
    const hit = crit || (toHit.natural !== 1 && toHit.total >= target.ac);
    rolls[rolls.length - 1].outcome =
      `vs AC ${target.ac} — ${crit ? "critical hit" : hit ? "hit" : "miss"}`;
    if (!hit) {
      events.push(`Missed ${target.name} (rolled ${toHit.total} vs AC ${target.ac}).`);
    } else {
      const dealt = playerAmount(
        "Damage",
        given.damage,
        `${ch.damageDie}${formatModifier(bonus.damage)}`,
        crit,
      );
      monsterHp[target.id] = Math.max(0, (monsterHp[target.id] ?? target.hp) - dealt);
      events.push(
        `${crit ? "Critical hit! " : ""}Hit ${target.name} for ${dealt} (rolled ${toHit.total} vs AC ${target.ac}).`,
      );
      if (monsterHp[target.id] === 0) {
        if (!gs.defeatedMonsters.includes(target.id)) gs.defeatedMonsters.push(target.id);
        events.push(`${target.name} defeated!`);
      }
    }
    // Acting first means anything you just dropped never swings; otherwise
    // everything standing at the start of the round gets its attack in.
    attackers = combat.playerFirst ? livingMonsters(node, monsterHp) : livingAtStart;
    if (combat.playerFirst && attackers.length === 0) {
      events.push("You struck first and cleared the room before anything could swing back.");
    }
  } else {
    attackers = livingAtStart; // busy with something else — anything still here attacks
  }

  // --- Monster attacks (always rolled by the engine) -------------------------
  for (const m of attackers) {
    if (ch.currentHp <= 0) break;
    const r = rollD20(dice, m.toHit, attackMode);
    const crit = r.natural === 20;
    const hit = crit || (r.natural !== 1 && r.total >= ch.ac);
    rolls.push({
      label: `${m.name} attacks`,
      by: "dice",
      expr: r.expr,
      dice: r.dice,
      total: r.total,
      outcome: `vs your AC ${ch.ac} — ${crit ? "critical hit" : hit ? "hit" : "miss"}`,
    });
    if (!hit) {
      events.push(`${m.name} attacks and misses.`);
      continue;
    }
    const dmg = rollDice(dice, m.damage, { critical: crit });
    const taken = Math.max(0, dmg.total);
    rolls.push({
      label: `${m.name} damage`,
      by: "dice",
      expr: dmg.expr,
      dice: dmg.dice,
      total: taken,
    });
    ch.currentHp = Math.max(0, ch.currentHp - taken);
    events.push(
      `${crit ? "Critical! " : ""}${m.name} hits you for ${taken} (HP ${ch.currentHp}/${ch.maxHp}).`,
    );
  }

  // --- Drink a potion -----------------------------------------------------------
  if (input.drinkPotion) {
    const idx = ch.inventory.findIndex((it) => it.toLowerCase().includes("potion"));
    if (idx === -1) {
      events.push("You reach for a potion, but have none left.");
    } else if (ch.currentHp >= ch.maxHp) {
      events.push("You're already at full health, so you keep the potion for later.");
    } else {
      const heal = playerAmount("Potion healing", given.heal, POTION_HEAL);
      const before = ch.currentHp;
      ch.currentHp = Math.min(ch.maxHp, before + heal);
      ch.inventory = consumePotion(ch.inventory, idx);
      events.push(
        `You drink a potion and recover ${ch.currentHp - before} HP (now ${ch.currentHp}/${ch.maxHp}).`,
      );
    }
  }

  // --- Search the room for loot (Perception vs. a flat DC) ------------------
  if (input.search) {
    const loot = node.loot ?? [];
    if (gs.searchedNodes.includes(gs.currentNode)) {
      events.push("You search again, but find nothing new.");
    } else {
      const perception = playerD20("Perception (search)", given.perception, bonus.perception);
      const found = perception.total >= SEARCH_DC;
      rolls[rolls.length - 1].outcome = `vs DC ${SEARCH_DC} — ${found ? "success" : "fail"}`;
      gs.searchedNodes.push(gs.currentNode);
      if (!found) {
        events.push(
          `You search but don't find anything (Perception ${perception.total} vs DC ${SEARCH_DC}).`,
        );
      } else if (loot.length > 0) {
        ch.inventory = [...ch.inventory, ...loot];
        events.push(
          `You search and find: ${loot.join(", ")} (Perception ${perception.total} vs DC ${SEARCH_DC}).`,
        );
      } else {
        events.push(
          `You search carefully but find nothing of value (Perception ${perception.total} vs DC ${SEARCH_DC}).`,
        );
      }
    }
  }

  // --- Death check (after any healing applied this turn) -----------------
  if (ch.currentHp <= 0) {
    gs.status = "dead";
    events.push("You have fallen. The campaign ends here.");
  }

  // --- Movement ------------------------------------------------------------
  if (gs.status === "active" && exit) {
    if (sneakSuccess) {
      moveToExit(gs, campaign, monsterHp, exit, events, "You slip");
    } else if (action === "flee") {
      moveToExit(gs, campaign, monsterHp, exit, events, "You flee");
    } else if (livingMonsters(node, monsterHp).length > 0) {
      if (action !== "sneak") {
        events.push("Enemies still block the way — clear the room, or sneak past or flee.");
      }
    } else {
      moveToExit(gs, campaign, monsterHp, exit, events, "You go");
    }
  }

  // --- Victory: goal node reached and cleared ------------------------------
  const cur = campaign.nodes[gs.currentNode];
  if (gs.status === "active" && cur.isGoal && livingMonsters(cur, monsterHp).length === 0) {
    gs.status = "won";
    events.push(`You have cleared ${cur.title}. Victory!`);
  }

  // --- Bookkeeping -----------------------------------------------------------
  gs.turnCount += 1;
  const turnLog = [
    ...state.turnLog,
    {
      turn: gs.turnCount,
      read: input.summary ?? "",
      result: events.length > 0 ? events.join(" ") : "No effect.",
    },
  ];

  return { state: { character: ch, gameState: gs, turnLog }, events, rolls };
}

/** Build a fresh hero from a (possibly partial) character sheet and (re)start
 *  the campaign at the first room. Gaps are filled by the dice: no class →
 *  one at random; each missing ability score → 4d6, drop the lowest. */
export function applyCharacterSheet(
  campaign: DndCampaignDefinition,
  sheet: DndCharacterSheetInput,
  dice: Dice,
): DndEngineResult {
  const rolls: DndRollRecord[] = [];
  const notes: string[] = [];

  const classGiven = Boolean((sheet.class ?? "").trim());
  const classId = classGiven
    ? normalizeClass(sheet.class)
    : CLASS_IDS[dice.die(CLASS_IDS.length) - 1];
  if (!classGiven)
    notes.push(`The dice chose your class: ${classId.charAt(0).toUpperCase()}${classId.slice(1)}.`);

  const scores: Partial<Record<DndAbility, number>> = {};
  const rolled: string[] = [];
  for (const ability of ABILITIES) {
    const value = sheet.scores?.[ability];
    if (typeof value === "number" && Number.isFinite(value)) {
      scores[ability] = value;
      continue;
    }
    const r = roll4d6DropLowest(dice);
    scores[ability] = r.total;
    rolled.push(ABILITY_ABBREVIATIONS[ability]);
    rolls.push({
      label: ABILITY_ABBREVIATIONS[ability],
      by: "dice",
      expr: "4d6, drop lowest",
      dice: r.dice,
      total: r.total,
    });
  }
  if (rolled.length > 0) {
    notes.push(
      `Rolled ${rolled.length === ABILITIES.length ? "all six ability scores" : rolled.join(", ")} (4d6, drop the lowest).`,
    );
  }

  const character = deriveCharacter({ name: sheet.name, class: classId, scores });
  const start = campaign.startNode ?? Object.keys(campaign.nodes)[0];

  const gameState: DndGameState = {
    currentNode: start,
    discoveredNodes: [start],
    defeatedMonsters: [],
    monsterHp: {},
    searchedNodes: [],
    combat: { node: null, playerFirst: null },
    status: "active",
    turnCount: 0,
  };

  const intro = `${character.name} the ${character.class} (HP ${character.maxHp}, AC ${character.ac}) enters ${campaign.campaignName}.`;
  const events = [intro, ...notes];

  const turnLog = [
    {
      turn: 0,
      read: `New hero: ${character.name} the ${character.class}.`,
      result: events.join(" "),
    },
  ];

  return { state: { character, gameState, turnLog }, events, rolls };
}
