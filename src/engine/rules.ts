import type { DndAbility, DndCharacter, DndCharacterSheetInput, DndClassId } from "./types";

/** Shared 5e-lite rules data: level-1 martial class profiles and the
 *  derivation from a rolled character sheet to a full character block.
 *  Ported from the old repo's `dnd/rules.py`. Martial classes only, no magic. */

export const ABILITIES: readonly DndAbility[] = [
  "strength",
  "dexterity",
  "constitution",
  "intelligence",
  "wisdom",
  "charisma",
];

interface DndClassProfile {
  hitDie: number;
  attackAbility: DndAbility;
  weapon: string;
  damageDie: string;
  ac: (mods: Record<DndAbility, number>) => number;
  inventory: string[];
  skills: string[];
}

const CLASS_PROFILES: Record<DndClassId, DndClassProfile> = {
  fighter: {
    hitDie: 10,
    attackAbility: "strength",
    weapon: "Longsword",
    damageDie: "1d8",
    ac: () => 18,
    inventory: ["Longsword", "Shield", "Chain mail", "Explorer's pack", "Health Potion x1"],
    skills: [],
  },
  rogue: {
    hitDie: 8,
    attackAbility: "dexterity",
    weapon: "Shortsword",
    damageDie: "1d6",
    ac: (m) => 11 + m.dexterity,
    inventory: ["Shortsword", "Shortbow", "Leather armor", "Thieves' tools", "Health Potion x1"],
    skills: ["Stealth"],
  },
  barbarian: {
    hitDie: 12,
    attackAbility: "strength",
    weapon: "Greataxe",
    damageDie: "1d12",
    ac: (m) => 10 + m.dexterity + m.constitution,
    inventory: ["Greataxe", "Handaxe x2", "Explorer's pack", "Health Potion x1"],
    skills: [],
  },
};

const DEFAULT_CLASS = "fighter" as const;

export const CLASS_IDS: readonly DndClassId[] = ["fighter", "rogue", "barbarian"];

/** One-line pitch per class — shown on the character-creation email and given
 *  to the reply parser so it can map "I want to be sneaky" onto a class. */
export const CLASS_SUMMARIES: Record<DndClassId, string> = {
  fighter: "d10 HP, chain mail + shield (AC 18), Longsword. Tough and reliable.",
  rogue: "d8 HP, leather armour (AC 11 + DEX), Shortsword + bow. Expert at sneaking.",
  barbarian: "d12 HP, unarmoured (AC 10 + DEX + CON), Greataxe. Big hits, big health.",
};

export const ABILITY_ABBREVIATIONS: Record<DndAbility, string> = {
  strength: "STR",
  dexterity: "DEX",
  constitution: "CON",
  intelligence: "INT",
  wisdom: "WIS",
  charisma: "CHA",
};

export function abilityMod(score: number): number {
  return Math.floor((score - 10) / 2);
}

export function proficiencyBonus(level: number): number {
  return 2 + Math.max(0, Math.floor((level - 1) / 4));
}

export function normalizeClass(name: string | null | undefined): DndClassId {
  const key = (name ?? "").trim().toLowerCase();
  return key in CLASS_PROFILES ? (key as DndClassId) : DEFAULT_CLASS;
}

/** The roll bonuses the player adds to a d20 (or, for damage, to the weapon
 *  die) — what the email's character block lists and what the engine adds
 *  when it rolls on the player's behalf. */
export interface CharacterBonuses {
  toHit: number;
  damage: number;
  stealth: number;
  perception: number;
  initiative: number;
}

export function characterBonuses(ch: DndCharacter): CharacterBonuses {
  const prof = proficiencyBonus(ch.level);
  const attackMod = ch.modifiers[ch.attackAbility];
  return {
    toHit: attackMod + prof,
    damage: attackMod,
    stealth: ch.modifiers.dexterity + (ch.skillProficiencies.includes("Stealth") ? prof : 0),
    perception: ch.modifiers.wisdom + (ch.skillProficiencies.includes("Perception") ? prof : 0),
    initiative: ch.modifiers.dexterity,
  };
}

/** Turn a rolled sheet (name, class, six ability scores) into a full level-1
 *  character block. Missing/garbled scores default to 10. */
export function deriveCharacter(sheet: DndCharacterSheetInput): DndCharacter {
  const classId = normalizeClass(sheet.class);
  const profile = CLASS_PROFILES[classId];

  const scores = {} as Record<DndAbility, number>;
  for (const ability of ABILITIES) {
    const raw = sheet.scores?.[ability];
    const value = typeof raw === "number" && Number.isFinite(raw) ? Math.trunc(raw) : 10;
    scores[ability] = Math.max(1, Math.min(20, value));
  }

  const modifiers = {} as Record<DndAbility, number>;
  for (const ability of ABILITIES) {
    modifiers[ability] = abilityMod(scores[ability]);
  }

  const maxHp = Math.max(1, profile.hitDie + modifiers.constitution);
  const name = (sheet.name ?? "").trim() || "Hero";

  return {
    name,
    class: classId.charAt(0).toUpperCase() + classId.slice(1),
    level: 1,
    maxHp,
    currentHp: maxHp,
    ac: profile.ac(modifiers),
    attackAbility: profile.attackAbility,
    weapon: profile.weapon,
    damageDie: profile.damageDie,
    inventory: [...profile.inventory],
    modifiers,
    scores,
    skillProficiencies: [...profile.skills],
  };
}
