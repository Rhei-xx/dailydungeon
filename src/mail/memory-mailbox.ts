import type { IncomingReply, Mailbox, OutgoingEmail } from "./mailbox";

/** An in-memory Mailbox for tests and offline previews — nothing leaves the process. */
export interface MemoryMailbox extends Mailbox {
  readonly inbox: IncomingReply[];
  readonly sent: OutgoingEmail[];
  readonly seen: Set<number>;
  /** Drop a reply from the player into the inbox. */
  receive(text: string, receivedAt: Date, messageId?: string): IncomingReply;
}

export function memoryMailbox(): MemoryMailbox {
  const inbox: IncomingReply[] = [];
  const sent: OutgoingEmail[] = [];
  const seen = new Set<number>();
  return {
    inbox,
    sent,
    seen,
    receive(text, receivedAt, messageId) {
      const reply: IncomingReply = {
        messageId: messageId ?? `<reply-${inbox.length + 1}@player.example>`,
        receivedAt,
        text,
        authenticated: true,
        uid: inbox.length + 1,
      };
      inbox.push(reply);
      return reply;
    },
    async fetchReplies(since) {
      return inbox
        .filter((r) => r.receivedAt > since)
        .sort((a, b) => a.receivedAt.getTime() - b.receivedAt.getTime());
    },
    async markProcessed(replies) {
      for (const r of replies) seen.add(r.uid);
    },
    async send(email) {
      sent.push(email);
    },
  };
}
