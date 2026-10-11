import { describe, expect, it } from "vitest";
import { SUNKEN_VAULT_CAMPAIGN } from "../engine/campaign";
import { scriptedDice } from "../engine/dice";
import { applyCharacterSheet, applyTurn, awaitingCharacterState } from "../engine/engine";
import type { DndPlayState } from "../engine/types";
import { REPLY_MARKER } from "../mail/reply-text";
import { renderMapText } from "./map";
import { renderEmail, type EmailView } from "./render";

const DATE = new Date("2026-10-11T11:05:00Z");
const ALL_TENS = {
  strength: 16,
  dexterity: 12,
  constitution: 14,
  intelligence: 8,
  wisdom: 10,
  charisma: 10,
};

function hero(): DndPlayState {
  return applyCharacterSheet(
    SUNKEN_VAULT_CAMPAIGN,
    { name: "Brakka", class: "barbarian", scores: ALL_TENS },
    scriptedDice([]),
  ).state;
}

/** Brakka has climbed down into the Tower Entry, where two rats wait. */
function inTowerEntry() {
  return applyTurn(
    hero(),
    SUNKEN_VAULT_CAMPAIGN,
    { action: "none", exit: "down", summary: "Climb down the rope." },
    scriptedDice([]),
  );
}

function view(overrides: Partial<EmailView>): EmailView {
  return {
    kind: "turn",
    campaign: SUNKEN_VAULT_CAMPAIGN,
    play: hero(),
    date: DATE,
    timeZone: "America/Toronto",
    deliveryTime: "07:00",
    ...overrides,
  };
}

describe("renderEmail", () => {
  it("renders the welcome email with the class choice and no hero yet", () => {
    const email = renderEmail(
      view({ kind: "welcome", play: awaitingCharacterState(SUNKEN_VAULT_CAMPAIGN) }),
    );
    expect(email.subject).toBe("Daily Dungeon · Create your hero");
    expect(email.text).toMatchSnapshot();
    expect(email.html).toContain("Brakka, barbarian");
    expect(email.html).not.toContain("Your hero");
  });

  it("renders a turn: what was read, the story, every roll, the room, map and hero", () => {
    const { state, events, rolls } = inTowerEntry();
    const email = renderEmail(
      view({
        play: state,
        readAs: "Climb down the rope.",
        narration: "You lower yourself hand over hand into the dark. Something squeaks below.",
        events,
        rolls,
      }),
    );
    expect(email.subject).toBe("Daily Dungeon · Turn 2 — The Tower Entry");
    expect(email.text).toMatchSnapshot();
    expect(email.html).toContain("Giant Rat — HP 7/7 · AC 12");
    expect(email.html).toContain("Attack the giant rat.");
  });

  it("lists rolls by who made them", () => {
    const { state } = inTowerEntry();
    const fight = applyTurn(
      state,
      SUNKEN_VAULT_CAMPAIGN,
      { action: "attack", rolls: { toHit: 17 } },
      // initiative 12+1 vs 12 (you first); greataxe 9+3 drops rat A; rat B rolls 3+4 vs AC 13, a miss
      scriptedDice([12, 9, 3]),
    );
    const email = renderEmail(
      view({ play: fight.state, events: fight.events, rolls: fight.rolls }),
    );
    expect(email.text).toContain("- To hit (Giant Rat): your roll = 17 (vs AC 12 — hit)");
    expect(email.text).toContain("- Damage: 1d12+3 [9] = 12");
    expect(email.html).toContain("1d20+4 [3]");
  });

  it("renders an unclear reply without pretending anything happened", () => {
    const { state } = inTowerEntry();
    const email = renderEmail(
      view({ kind: "unclear", play: state, clarification: "Which way did you want to go?" }),
    );
    expect(email.subject).toBe("Daily Dungeon · Turn 2 — I didn't catch that");
    expect(email.text).toContain("Which way did you want to go?");
    expect(email.text).toContain("Nothing happened");
  });

  it("renders a reminder, including before any hero exists", () => {
    const { state } = inTowerEntry();
    expect(renderEmail(view({ kind: "reminder", play: state })).subject).toBe(
      "Daily Dungeon · Your adventure awaits — The Tower Entry",
    );
    const early = renderEmail(
      view({ kind: "reminder", play: awaitingCharacterState(SUNKEN_VAULT_CAMPAIGN) }),
    );
    expect(early.text).toContain("CHOOSE A CLASS");
    expect(early.text).not.toContain("YOUR HERO");
  });

  it("renders death and victory with a run summary and a way to play again", () => {
    const dead = hero();
    dead.gameState.status = "dead";
    dead.character.currentHp = 0;
    const run = {
      campaignId: "abc",
      characterName: "Brakka",
      characterClass: "Barbarian",
      outcome: "dead" as const,
      turns: 6,
      endedAt: DATE.toISOString(),
    };
    const death = renderEmail(
      view({ kind: "death", play: dead, events: ["You have fallen."], finishedRun: run }),
    );
    expect(death.subject).toBe("Daily Dungeon · Brakka has fallen");
    expect(death.text).toMatchSnapshot();

    const won = hero();
    won.gameState.status = "won";
    const victory = renderEmail(
      view({ kind: "victory", play: won, finishedRun: { ...run, outcome: "won" } }),
    );
    expect(victory.subject).toBe("Daily Dungeon · Victory! Brakka cleared The Sunken Vault");
    expect(victory.text).toContain("Brakka the Barbarian won the day after 6 turns.");
  });

  it("is Gmail-safe: marker first, escaped, no images, SVG or scripts", () => {
    const state = hero();
    state.character.name = "<b>Evil</b> & Co";
    const email = renderEmail(
      view({ kind: "hero", play: state, narration: "A <script>tale</script>." }),
    );
    expect(email.text.startsWith(REPLY_MARKER)).toBe(true);
    expect(email.html).toContain(REPLY_MARKER);
    expect(email.html).toContain("&lt;b&gt;Evil&lt;/b&gt; &amp; Co");
    expect(email.html).not.toMatch(/<(img|svg|script)\b/i);
    expect(email.html).toContain("max-width:600px");
  });
});

describe("renderMapText", () => {
  it("draws only discovered rooms, joined where both ends are known", () => {
    const { state } = inTowerEntry();
    state.gameState.discoveredNodes.push("goblin_guardpost", "rat_warren");
    expect(renderMapText(SUNKEN_VAULT_CAMPAIGN, state.gameState)).toBe(
      ["      [ ]", "       |", "[ ]---[@]---[ ]"].join("\n"),
    );
  });
});
