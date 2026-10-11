import { narrate, type NarrationInput } from "./ai/narrate";
import { parseReply } from "./ai/parse-reply";
import { buildParseContext, type ParsedReply } from "./ai/reply-types";
import type { TextModel } from "./ai/gemini";
import { SUNKEN_VAULT_CAMPAIGN } from "./engine/campaign";
import { seededDice } from "./engine/dice";
import { applyCharacterSheet, applyTurn, awaitingCharacterState } from "./engine/engine";
import type { DndCampaignDefinition, DndEngineResult } from "./engine/types";
import { renderEmail, type EmailKind, type EmailView } from "./email/render";
import { messageIdFor, type IncomingReply, type Mailbox } from "./mail/mailbox";
import { extractReplyText } from "./mail/reply-text";
import {
  freshGameFile,
  newCampaignId,
  withProcessed,
  type FinishedRun,
  type GameFile,
  type StateStore,
} from "./store/state-file";
import { DAY_MS, isDue, localParts } from "./time";

/** One quiet stretch this long earns a single "your adventure awaits" email. */
export const REMINDER_AFTER_DAYS = 3;

export interface TickDeps {
  store: StateStore;
  mailbox: Mailbox;
  /** null = no Gemini: keyword parsing and plain engine text. */
  model: TextModel | null;
  now: Date;
  timeZone: string;
  deliveryTime: string;
  campaign?: DndCampaignDefinition;
  log?: (message: string) => void;
}

export interface TickOptions {
  /** Run even if it isn't delivery time yet, or today's run already happened. */
  force?: boolean;
  /** Read the inbox and build the email, but send, mark and save nothing. */
  dryRun?: boolean;
}

export interface TickResult {
  status: "not_due" | "sent" | "quiet";
  kind?: EmailKind;
  subject?: string;
  /** The email that was (or, on a dry run, would have been) sent. */
  email?: { subject: string; text: string; html: string; messageId: string };
  repliesRead: number;
  parsedBy?: ParsedReply["source"];
  saved: boolean;
}

interface Outcome {
  game: GameFile;
  view: Omit<EmailView, "campaign" | "date" | "timeZone" | "deliveryTime">;
}

function finishedRun(game: GameFile, outcome: FinishedRun["outcome"], now: Date): FinishedRun {
  return {
    campaignId: game.campaignId,
    characterName: game.play.character.name,
    characterClass: game.play.character.class,
    outcome,
    turns: game.play.gameState.turnCount,
    endedAt: now.toISOString(),
  };
}

function narrationInput(
  campaign: DndCampaignDefinition,
  before: GameFile,
  result: DndEngineResult,
  move: string,
  outcome: NarrationInput["outcome"],
): NarrationInput {
  const to = campaign.nodes[result.state.gameState.currentNode];
  return {
    characterName: result.state.character.name,
    characterClass: result.state.character.class,
    fromRoom: campaign.nodes[before.play.gameState.currentNode].title,
    toRoom: to.title,
    toRoomDescription: to.description,
    move,
    events: result.events,
    outcome,
  };
}

/** The narrator's paragraph, or nothing when it fell back to the engine's own
 *  sentences — those are already listed under "What happened". */
function storyText(story: { text: string; source: "gemini" | "fallback" }): string | undefined {
  return story.source === "gemini" ? story.text : undefined;
}

/** Apply one interpreted reply to the game. Pure apart from the narrator call. */
async function applyReply(
  game: GameFile,
  reply: IncomingReply,
  parsed: ParsedReply,
  deps: TickDeps,
  campaign: DndCampaignDefinition,
): Promise<Outcome> {
  // Same campaign + turn + reply → same dice, so a retried run replays exactly.
  const dice = seededDice(`${game.campaignId}|${game.play.gameState.turnCount}|${reply.messageId}`);
  const readAs = parsed.summary || undefined;

  if (parsed.intent === "unclear") {
    return {
      game,
      view: { kind: "unclear", play: game.play, readAs, clarification: parsed.clarification },
    };
  }

  if (parsed.intent === "restart") {
    const history =
      game.play.gameState.status === "active"
        ? [...game.history, finishedRun(game, "restarted", deps.now)]
        : game.history;
    const next: GameFile = {
      ...game,
      campaignId: newCampaignId(),
      play: awaitingCharacterState(campaign),
      history,
    };
    return { game: next, view: { kind: "welcome", play: next.play, finishedRun: history.at(-1) } };
  }

  if (parsed.intent === "character") {
    const result = applyCharacterSheet(campaign, parsed.character ?? {}, dice);
    const next: GameFile = { ...game, campaignId: newCampaignId(), play: result.state };
    const story = await narrate(
      deps.model,
      narrationInput(
        campaign,
        { ...game, play: result.state },
        result,
        readAs ?? "",
        "new_character",
      ),
    );
    return {
      game: next,
      view: {
        kind: "hero",
        play: result.state,
        readAs,
        narration: storyText(story),
        events: result.events,
        rolls: result.rolls,
      },
    };
  }

  const result = applyTurn(game.play, campaign, parsed.move ?? { action: "none" }, dice);
  const status = result.state.gameState.status;
  const ended = status === "won" || status === "dead";
  let next: GameFile = { ...game, play: result.state };
  let run: FinishedRun | undefined;
  if (ended) {
    run = finishedRun(next, status === "won" ? "won" : "dead", deps.now);
    next = { ...next, history: [...next.history, run] };
  }
  const outcome = status === "won" ? "won" : status === "dead" ? "dead" : "ongoing";
  const story = await narrate(
    deps.model,
    narrationInput(campaign, game, result, readAs ?? "", outcome),
  );
  return {
    game: next,
    view: {
      kind: status === "won" ? "victory" : status === "dead" ? "death" : "turn",
      play: result.state,
      readAs,
      narration: storyText(story),
      events: result.events,
      rolls: result.rolls,
      finishedRun: run,
    },
  };
}

/**
 * The daily run: if it's due, read the player's latest reply since the last
 * email, play it, and send the result — or, with no reply, stay quiet (and
 * nudge once after a few quiet days). Sends before saving, so a failure
 * anywhere leaves the saved game untouched and the next run retries; the
 * seeded dice and stable Message-ID make that retry an exact replay.
 */
export async function tick(deps: TickDeps, opts: TickOptions = {}): Promise<TickResult> {
  const campaign = deps.campaign ?? SUNKEN_VAULT_CAMPAIGN;
  const log = deps.log ?? (() => {});
  const game = (await deps.store.load()) ?? freshGameFile();
  const { isoDate } = localParts(deps.now, deps.timeZone);

  if (
    !opts.force &&
    !isDue(deps.now, deps.timeZone, deps.deliveryTime, game.mail.lastRunLocalDate)
  ) {
    log(
      `Not due: delivery is ${deps.deliveryTime} ${deps.timeZone}, last run ${game.mail.lastRunLocalDate ?? "never"}.`,
    );
    return { status: "not_due", repliesRead: 0, saved: false };
  }

  let outcome: Outcome | null = null;
  let fresh: IncomingReply[] = [];
  let parsedBy: ParsedReply["source"] | undefined;
  let replyId: string | undefined;

  if (!game.mail.lastSentAt) {
    log("First run: sending the welcome email.");
    outcome = { game, view: { kind: "welcome", play: game.play } };
  } else {
    const replies = await deps.mailbox.fetchReplies(new Date(game.mail.lastSentAt));
    fresh = replies.filter((r) => !game.mail.processedMessageIds.includes(r.messageId));
    const latest = fresh.at(-1);
    if (latest) {
      log(`Read ${fresh.length} new repl${fresh.length === 1 ? "y" : "ies"}; playing the latest.`);
      const text = extractReplyText(latest.text);
      const parsed = await parseReply(deps.model, text, buildParseContext(game.play, campaign));
      parsedBy = parsed.source;
      replyId = latest.messageId;
      log(
        `Parsed (${parsed.source}) as ${parsed.intent}: ${parsed.summary || parsed.clarification || ""}`,
      );
      outcome = await applyReply(game, latest, parsed, deps, campaign);
    } else {
      const quietDays = (deps.now.getTime() - new Date(game.mail.lastSentAt).getTime()) / DAY_MS;
      const turn = game.play.gameState.turnCount;
      if (quietDays >= REMINDER_AFTER_DAYS && game.mail.remindedForTurn !== turn) {
        log(`No reply for ${Math.floor(quietDays)} days: sending the one reminder.`);
        outcome = { game, view: { kind: "reminder", play: game.play } };
      } else {
        log("No new reply; staying quiet.");
      }
    }
  }

  if (!outcome) {
    const next: GameFile = { ...game, mail: { ...game.mail, lastRunLocalDate: isoDate } };
    if (!opts.dryRun) await deps.store.save(next);
    return { status: "quiet", repliesRead: 0, saved: !opts.dryRun };
  }

  const kind = outcome.view.kind;
  const rendered = renderEmail({
    ...outcome.view,
    campaign,
    date: deps.now,
    timeZone: deps.timeZone,
    deliveryTime: deps.deliveryTime,
  });
  const messageId = messageIdFor({
    campaignId: game.campaignId,
    turn: game.play.gameState.turnCount,
    kind,
    replyId,
  });
  const email = { ...rendered, messageId };

  const mail = withProcessed(
    outcome.game.mail,
    fresh.map((r) => r.messageId),
  );
  const next: GameFile = {
    ...outcome.game,
    mail: {
      ...mail,
      lastSentAt: deps.now.toISOString(),
      lastMessageId: messageId,
      lastRunLocalDate: isoDate,
      // Read a reply → the quiet clock restarts; sent a reminder → don't repeat it.
      remindedForTurn:
        kind === "reminder"
          ? game.play.gameState.turnCount
          : fresh.length > 0
            ? undefined
            : mail.remindedForTurn,
    },
  };

  if (opts.dryRun) {
    log(`Dry run: would send "${email.subject}".`);
    return {
      status: "sent",
      kind,
      subject: email.subject,
      email,
      repliesRead: fresh.length,
      parsedBy,
      saved: false,
    };
  }

  await deps.mailbox.send(email);
  log(`Sent "${email.subject}".`);
  try {
    await deps.mailbox.markProcessed(fresh);
  } catch (err) {
    // Cosmetic (the \Seen flag) — processedMessageIds is what actually
    // prevents a replay, and it's saved below.
    log(`Couldn't mark replies as read: ${err instanceof Error ? err.message : String(err)}`);
  }
  await deps.store.save(next);
  return {
    status: "sent",
    kind,
    subject: email.subject,
    email,
    repliesRead: fresh.length,
    parsedBy,
    saved: true,
  };
}
