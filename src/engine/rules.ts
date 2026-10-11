import type { DndAbility, DndCharacter, DndCharacterSheetInput } from "./types";

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

const CLASS_PROFILES: Record<"fighter" | "rogue" | "barbarian", DndClassProfile> = {
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

export function abilityMod(score: number): number {
  return Math.floor((score - 10) / 2);
}

export function proficiencyBonus(level: number): number {
  return 2 + Math.max(0, Math.floor((level - 1) / 4));
}

export function normalizeClass(name: string | null | undefined): keyof typeof CLASS_PROFILES {
  const key = (name ?? "").trim().toLowerCase();
  return key in CLASS_PROFILES ? (key as keyof typeof CLASS_PROFILES) : DEFAULT_CLASS;
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
