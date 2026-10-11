import { createHash } from "node:crypto";

/** One email the game sends to the player. */
export interface OutgoingEmail {
  subject: string;
  html: string;
  text: string;
  /** Deterministic per email (see messageIdFor) — a retried run re-sends
   *  the same Message-ID, which Gmail collapses instead of showing twice. */
  messageId: string;
}

/** A reply from the player, already parsed out of its MIME source. */
export interface IncomingReply {
  messageId: string;
  receivedAt: Date;
  /** Full plain-text body, quoted history and all — see extractReplyText. */
  text: string;
  /** Whether the receiving server vouched for the sender (DMARC pass). */
  authenticated: boolean;
  /** Opaque handle the mailbox uses to mark this reply processed. */
  uid: number;
}

/** The game's only view of email — a bot Gmail account in production, an
 *  in-memory fake in tests and previews. */
export interface Mailbox {
  /** Replies from the player received strictly after `since`, oldest first. */
  fetchReplies(since: Date): Promise<IncomingReply[]>;
  /** Mark replies as handled (seen) so the bot inbox reads as done. */
  markProcessed(replies: IncomingReply[]): Promise<void>;
  send(email: OutgoingEmail): Promise<void>;
}

/** A stable Message-ID from the facts that define one email: the campaign,
 *  the turn, its kind, the reply it answers (if any), and the email sent
 *  before it. Chaining on the previous email keeps every send unique (two
 *  reminders for the same turn can't collide) while a retry of the same run,
 *  which starts from the same saved game, reproduces the same id. */
export function messageIdFor(parts: {
  campaignId: string;
  turn: number;
  kind: string;
  replyId?: string;
  previousId?: string;
}): string {
  const digest = createHash("sha256")
    .update(
      [parts.campaignId, parts.turn, parts.kind, parts.replyId ?? "", parts.previousId ?? ""].join(
        "|",
      ),
    )
    .digest("hex")
    .slice(0, 20);
  return `<dd.${parts.kind}.${parts.turn}.${digest}@dailydungeon.invalid>`;
}
