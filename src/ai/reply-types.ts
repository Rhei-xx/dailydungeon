import { exitDirections, livingMonsters } from "../engine/engine";
import { CLASS_SUMMARIES } from "../engine/rules";
import type {
  DndCampaignDefinition,
  DndCharacterSheetInput,
  DndClassId,
  DndGameStatus,
  DndPlayState,
  DndTurnInput,
} from "../engine/types";

export type ReplyIntent = "character" | "move" | "restart" | "unclear";

/** A player's reply, interpreted — what the engine will be asked to do. */
export interface ParsedReply {
  intent: ReplyIntent;
  /** Present when intent === "move". */
  move?: DndTurnInput;
  /** Present when intent === "character". */
  character?: DndCharacterSheetInput;
  /** What was understood, in a line — echoed back as "Your move, as I read it". */
  summary: string;
  /** When intent === "unclear": what to tell the player. */
  clarification?: string;
  /** Which parser produced this — the Gemini read or the keyword fallback. */
  source: "gemini" | "heuristic";
}

/** What the parser needs to know about the game to read a reply sensibly. */
export interface ParseContext {
  status: DndGameStatus;
  roomTitle: string;
  /** Names of monsters still standing in the room. */
  monsters: string[];
  /** Exit directions out of the room, lowercase. */
  exits: string[];
  hasPotion: boolean;
  classes: Record<DndClassId, string>;
}

export function buildParseContext(
  play: DndPlayState,
  campaign: DndCampaignDefinition,
): ParseContext {
  const node = campaign.nodes[play.gameState.currentNode];
  return {
    status: play.gameState.status,
    roomTitle: node.title,
    monsters: livingMonsters(node, play.gameState.monsterHp).map((m) => m.name),
    exits: exitDirections(node),
    hasPotion: play.character.inventory.some((i) => i.toLowerCase().includes("potion")),
    classes: CLASS_SUMMARIES,
  };
}

/** "restart" is only honoured when the player plainly asked for it — a
 *  misread must never throw away a campaign. */
export function explicitlyAsksToRestart(text: string): boolean {
  return /\brestart\b|\bnew character\b|\bstart over\b/i.test(text);
}

/** Whether replies right now should create a character rather than move one. */
export function expectsCharacter(status: DndGameStatus): boolean {
  return status !== "active";
}
