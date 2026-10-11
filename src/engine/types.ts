export type DndAbility = "strength" | "dexterity" | "constitution" | "intelligence" | "wisdom" | "charisma";

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
  attack: string;
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
  read: string;
  result: string;
  confidence?: DndConfidence | null;
  misreadFlag: boolean;
}

/** Everything the plugin needs to render + the engine needs to update, absent
 *  the campaign definition itself (which is fixed/shared, not per-user). */
export interface DndPlayState {
  character: DndCharacter;
  gameState: DndGameState;
  turnLog: DndTurnLogEntry[];
}

export type DndConfidence = "high" | "medium" | "low";

export interface DndDiceRoll {
  label: string;
  total: number | null;
}

/** One interpreted move, as read off a mailed-back page. Mirrors the JSON
 *  shape produced by the old repo's `process_vision.py` (snake_case there,
 *  camelCase here). */
export interface DndMoveInput {
  diceRolls?: DndDiceRoll[];
  damageDealt?: number | null;
  damageTaken?: number | null;
  healAmount?: number | null;
  stealthRoll?: number | null;
  initiativeRoll?: number | null;
  /** Roll vs. a flat DC to find loot when searching — new mechanic, not in
   *  the old repo (which resolved search unconditionally, no roll). */
  perceptionRoll?: number | null;
  chosenExit?: string | null;
  checkboxesMarked?: string[];
  misreadFlag?: boolean;
  actionsSummary?: string;
  confidence?: DndConfidence;
}

/** A filled-in character-creation sheet, as read off a mailed-back page. */
export interface DndCharacterSheetInput {
  name?: string | null;
  class?: string | null;
  scores?: Partial<Record<DndAbility, number | null>>;
  confidence?: DndConfidence;
}

export interface DndEngineResult {
  state: DndPlayState;
  events: string[];
}
