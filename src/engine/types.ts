export type DndAbility =
  "strength" | "dexterity" | "constitution" | "intelligence" | "wisdom" | "charisma";

export type DndClassId = "fighter" | "rogue" | "barbarian";

/** A level-1 martial character, fully derived from a filled-in creation sheet. */
export interface DndCharacter {
  name: string;
  /** Capitalized display form, e.g. "Fighter" — derived once at creation, not re-derived from classId. */
  class: string;
  level: number;
  maxHp: number;
  currentHp: number;
  ac: number;
  attackAbility: DndAbility;
  weapon: string;
  damageDie: string;
  inventory: string[];
  modifiers: Record<DndAbility, number>;
  scores: Record<DndAbility, number>;
  skillProficiencies: string[];
}

export interface DndMonster {
  id: string;
  name: string;
  hp: number;
  ac: number;
  /** Display form of the attack, e.g. "+4 to hit, 1d4+2 piercing". */
  attack: string;
  /** The same attack, structured for the engine to roll: d20 + toHit vs AC, then `damage`. */
  toHit: number;
  damage: string;
  dexMod: number;
  passivePerception: number;
}

export interface DndCampaignNode {
  title: string;
  x: number;
  y: number;
  description: string;
  monsters: DndMonster[];
  /** Exit direction (lowercase, e.g. "north"/"down") -> destination node id. */
  exits: Record<string, string>;
  loot?: string[];
  isGoal?: boolean;
}

export interface DndCampaignDefinition {
  campaignName: string;
  schemaVersion: number;
  grid: { cols: number; rows: number };
  startNode: string;
  goalNode: string;
  nodes: Record<string, DndCampaignNode>;
}

export interface DndCombatTracker {
  node: string | null;
  playerFirst: boolean | null;
}

export type DndGameStatus = "awaiting_character" | "active" | "dead" | "won";

export interface DndGameState {
  currentNode: string;
  discoveredNodes: string[];
  defeatedMonsters: string[];
  /** Monster id -> remaining HP. Absent entries default to the monster's full HP. */
  monsterHp: Record<string, number>;
  searchedNodes: string[];
  combat: DndCombatTracker;
  status: DndGameStatus;
  turnCount: number;
}

export interface DndTurnLogEntry {
  turn: number;
  /** The move as the parser understood it, e.g. "Attack the rat, then head east." */
  read: string;
  result: string;
}

/** Everything the email needs to render + the engine needs to update, absent
 *  the campaign definition itself (which is fixed/shared, not per-player). */
export interface DndPlayState {
  character: DndCharacter;
  gameState: DndGameState;
  turnLog: DndTurnLogEntry[];
}

export type DndAction = "attack" | "sneak" | "flee" | "dodge" | "none";

/** Totals the player rolled themselves and typed into their reply (modifiers
 *  already added). Anything absent/null is rolled by the engine instead. */
export interface DndPlayerRolls {
  initiative?: number | null;
  toHit?: number | null;
  damage?: number | null;
  stealth?: number | null;
  perception?: number | null;
  heal?: number | null;
}

/** One interpreted move, as parsed from the player's email reply. At most one
 *  primary `action` resolves per turn; potion, search and moving through an
 *  exit can ride along with it. */
export interface DndTurnInput {
  action: DndAction;
  /** Exit direction to take this turn (lowercase, e.g. "north"/"down"). */
  exit?: string | null;
  drinkPotion?: boolean;
  search?: boolean;
  rolls?: DndPlayerRolls;
  /** One-line restatement of the move, echoed back in the next email and kept in the turn log. */
  summary?: string;
}

/** A filled-in character sheet, as parsed from a reply. Anything missing is
 *  filled by the dice: class picked at random, ability scores 4d6-drop-lowest. */
export interface DndCharacterSheetInput {
  name?: string | null;
  class?: string | null;
  scores?: Partial<Record<DndAbility, number | null>>;
}

/** One die roll (or player-supplied total) the engine resolved this turn —
 *  listed in the email so every number behind the story is checkable. */
export interface DndRollRecord {
  label: string;
  /** "you" = a total the player typed in; "dice" = rolled by the engine. */
  by: "you" | "dice";
  /** What was rolled, e.g. "1d20+5"; absent for player-supplied totals. */
  expr?: string;
  /** Raw faces; absent for player-supplied totals. */
  dice?: number[];
  total: number;
  /** Verdict shown next to the roll, e.g. "vs AC 15 — hit". */
  outcome?: string;
}

export interface DndEngineResult {
  state: DndPlayState;
  events: string[];
  rolls: DndRollRecord[];
}
