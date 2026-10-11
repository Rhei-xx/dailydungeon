import { describe, expect, it } from "vitest";
import { SUNKEN_VAULT_CAMPAIGN } from "./engine/campaign";
import { scriptedDice } from "./engine/dice";
import { applyCharacterSheet, applyTurn } from "./engine/engine";
import { memoryMailbox, type MemoryMailbox } from "./mail/memory-mailbox";
import { freshGameFile, type GameFile, type StateStore } from "./store/state-file";
import { tick, type TickDeps } from "./tick";

// October 2026: Toronto is on EDT (UTC-4), so 07:00 local is 11:00Z.
const TZ = "America/Toronto";
const day = (n: number, utcTime = "11:20") =>
  new Date(`2026-10-${String(10 + n).padStart(2, "0")}T${utcTime}:00Z`);

const STATS = {
  strength: 16,
  dexterity: 12,
  constitution: 14,
  intelligence: 8,
  wisdom: 10,
  charisma: 10,
};

function memoryStore(initial: GameFile | null = null) {
  let game = initial ? structuredClone(initial) : null;
  let saves = 0;
  const store: StateStore & { readonly game: GameFile | null; readonly saves: number } = {
    location: "memory",
    async load() {
      return game ? structuredClone(game) : null;
    },
    async save(next) {
      game = structuredClone(next);
      saves += 1;
    },
    get game() {
      return game;
    },
    get saves() {
      return saves;
    },
  };
  return store;
}

/** Brakka the Barbarian, standing in the Tower Entry with both rats alive;
 *  the last email went out on day 1. */
function activeGame(): GameFile {
  const game = freshGameFile();
  game.campaignId = "c0ffee000001";
  const hero = applyCharacterSheet(
    SUNKEN_VAULT_CAMPAIGN,
    { name: "Brakka", class: "barbarian", scores: STATS },
    scriptedDice([]),
  ).state;
  game.play = applyTurn(
    hero,
    SUNKEN_VAULT_CAMPAIGN,
    { action: "none", exit: "down" },
    scriptedDice([]),
  ).state;
  game.mail = {
    lastSentAt: day(1).toISOString(),
    lastRunLocalDate: "2026-10-11",
    processedMessageIds: [],
  };
  return game;
}

function deps(store: StateStore, mailbox: MemoryMailbox, now: Date): TickDeps {
  return { store, mailbox, model: null, now, timeZone: TZ, deliveryTime: "07:00" };
}

describe("tick — scheduling", () => {
  it("waits for the delivery time, then runs once per local day", async () => {
    const store = memoryStore();
    const mailbox = memoryMailbox();

    expect((await tick(deps(store, mailbox, day(1, "10:30")))).status).toBe("not_due"); // 06:30 local
    expect(store.saves).toBe(0);

    const first = await tick(deps(store, mailbox, day(1)));
    expect(first).toMatchObject({ status: "sent", kind: "welcome", saved: true });
    expect(mailbox.sent[0].subject).toBe("Daily Dungeon · Create your hero");
    expect(store.game?.mail.lastRunLocalDate).toBe("2026-10-11");

    expect((await tick(deps(store, mailbox, day(1, "15:00")))).status).toBe("not_due");
    expect((await tick(deps(store, mailbox, day(2)))).status).toBe("quiet");
    expect(store.game?.mail.lastRunLocalDate).toBe("2026-10-12");
    expect(mailbox.sent).toHaveLength(1);
  });

  it("runs anyway when forced", async () => {
    const result = await tick(deps(memoryStore(), memoryMailbox(), day(1, "09:00")), {
      force: true,
    });
    expect(result.status).toBe("sent");
  });
});

describe("tick — playing replies", () => {
  it("creates the hero from a reply, then plays the next reply as a move", async () => {
    const store = memoryStore();
    const mailbox = memoryMailbox();
    await tick(deps(store, mailbox, day(1)));

    mailbox.receive("Brakka, barbarian. STR 16 DEX 12 CON 14 INT 8 WIS 10 CHA 10", day(1, "15:00"));
    const hero = await tick(deps(store, mailbox, day(2)));
    expect(hero).toMatchObject({ kind: "hero", repliesRead: 1, parsedBy: "heuristic" });
    expect(hero.subject).toBe("Daily Dungeon · Brakka the Barbarian enters The Sunken Vault");
    expect(store.game?.play.gameState.status).toBe("active");
    expect(store.game?.play.character.scores.strength).toBe(16);
    expect(store.game?.mail.processedMessageIds).toEqual(["<reply-1@player.example>"]);
    expect(mailbox.seen.has(1)).toBe(true);

    mailbox.receive("Climb down the rope", day(2, "18:00"));
    const turn = await tick(deps(store, mailbox, day(3)));
    expect(turn.subject).toBe("Daily Dungeon · Turn 2 — The Tower Entry");
    expect(store.game?.play.gameState.currentNode).toBe("tower_entry");
    expect(turn.email?.text).toContain("Your move, as I read it: Go down.");
  });

  it("plays only the latest reply, marking the earlier one superseded", async () => {
    const store = memoryStore(activeGame());
    const mailbox = memoryMailbox();
    mailbox.receive("attack the rat", day(1, "14:00"));
    mailbox.receive("actually, sneak past and go east", day(1, "16:00"));

    const result = await tick(deps(store, mailbox, day(2)));
    expect(result.repliesRead).toBe(2);
    expect(store.game?.play.turnLog.at(-1)?.read).toBe("Sneak, go east.");
    expect(store.game?.mail.processedMessageIds).toEqual([
      "<reply-1@player.example>",
      "<reply-2@player.example>",
    ]);
    expect([...mailbox.seen]).toEqual([1, 2]);
  });

  it("answers an unclear reply without changing the game", async () => {
    const before = activeGame();
    const store = memoryStore(before);
    const mailbox = memoryMailbox();
    mailbox.receive("what's for dinner?", day(1, "14:00"));

    const result = await tick(deps(store, mailbox, day(2)));
    expect(result.kind).toBe("unclear");
    expect(result.subject).toBe("Daily Dungeon · Turn 2 — I didn't catch that");
    expect(store.game?.play).toEqual(before.play);
    expect(store.game?.mail.processedMessageIds).toContain("<reply-1@player.example>");
  });

  it("ignores replies it has already played", async () => {
    const store = memoryStore(activeGame());
    const mailbox = memoryMailbox();
    mailbox.receive("search the room", day(1, "14:00"));
    await tick(deps(store, mailbox, day(2)));
    // Even forced, and even if the inbox still shows it, the reply isn't replayed.
    store.game!.mail.lastSentAt = day(1).toISOString();
    const again = await tick(deps(store, mailbox, day(2, "13:00")), { force: true });
    expect(again.status).toBe("quiet");
  });

  it("replays a retried run exactly: same dice, same email, same Message-ID", async () => {
    const start = activeGame();
    const mailbox = memoryMailbox();
    mailbox.receive("attack the nearest rat", day(1, "14:00"));

    // The first run's save is "lost" (e.g. the state push failed), so the
    // retry starts again from the same saved game.
    const storeA = memoryStore(start);
    const storeB = memoryStore(start);
    const first = await tick(deps(storeA, mailbox, day(2)));
    const retry = await tick(deps(storeB, mailbox, day(2, "12:20")));
    expect(retry.email?.messageId).toBe(first.email?.messageId);
    expect(retry.email?.text).toBe(first.email?.text);
    expect(storeB.game?.play).toEqual(storeA.game?.play);
  });
});

describe("tick — quiet days", () => {
  it("stays quiet without a reply, then sends exactly one reminder after 3 days", async () => {
    const store = memoryStore();
    const mailbox = memoryMailbox();
    await tick(deps(store, mailbox, day(1)));

    for (const n of [2, 3]) expect((await tick(deps(store, mailbox, day(n)))).status).toBe("quiet");
    const reminder = await tick(deps(store, mailbox, day(4)));
    expect(reminder.kind).toBe("reminder");
    expect(reminder.subject).toBe("Daily Dungeon · Your adventure awaits — create your hero");
    for (const n of [5, 6, 7, 8])
      expect((await tick(deps(store, mailbox, day(n)))).status).toBe("quiet");
    expect(mailbox.sent.map((e) => e.subject)).toHaveLength(2);
  });

  it("restarts the quiet clock once a reply is read", async () => {
    const game = activeGame();
    game.mail.remindedForTurn = game.play.gameState.turnCount;
    const store = memoryStore(game);
    const mailbox = memoryMailbox();
    mailbox.receive("hmm", day(1, "14:00")); // unclear: turn count doesn't move
    await tick(deps(store, mailbox, day(2)));
    expect(store.game?.mail.remindedForTurn).toBeUndefined();
  });
});

describe("tick — endings", () => {
  it("records a death, then starts a new campaign from the next character reply", async () => {
    const game = activeGame();
    game.play.character.currentHp = 0; // already on the floor: any move ends it
    const store = memoryStore(game);
    const mailbox = memoryMailbox();
    mailbox.receive("dodge", day(1, "14:00"));

    const death = await tick(deps(store, mailbox, day(2)));
    expect(death.subject).toBe("Daily Dungeon · Brakka has fallen");
    expect(store.game?.history).toMatchObject([
      { characterName: "Brakka", outcome: "dead", turns: 2 },
    ]);

    mailbox.receive("Vex, rogue", day(2, "14:00"));
    const hero = await tick(deps(store, mailbox, day(3)));
    expect(hero.kind).toBe("hero");
    expect(store.game?.play.character).toMatchObject({ name: "Vex", class: "Rogue" });
    expect(store.game?.campaignId).not.toBe("c0ffee000001");
  });

  it("restarts mid-adventure only on request, recording the run as retired", async () => {
    const store = memoryStore(activeGame());
    const mailbox = memoryMailbox();
    mailbox.receive("restart", day(1, "14:00"));

    const result = await tick(deps(store, mailbox, day(2)));
    expect(result.kind).toBe("welcome");
    expect(result.email?.text).toContain("Brakka the Barbarian retired after 1 turn.");
    expect(store.game?.play.gameState.status).toBe("awaiting_character");
    expect(store.game?.history.at(-1)?.outcome).toBe("restarted");
  });
});

describe("tick — dry run", () => {
  it("builds the email but sends, marks and saves nothing", async () => {
    const store = memoryStore(activeGame());
    const mailbox = memoryMailbox();
    mailbox.receive("search the room", day(1, "14:00"));

    const result = await tick(deps(store, mailbox, day(2)), { dryRun: true });
    expect(result).toMatchObject({ status: "sent", kind: "turn", saved: false });
    expect(result.email?.text).toContain("Search the room.");
    expect(mailbox.sent).toHaveLength(0);
    expect(mailbox.seen.size).toBe(0);
    expect(store.saves).toBe(0);
  });
});
