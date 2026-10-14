import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import nodemailer from "nodemailer";
import type { IncomingReply, Mailbox, OutgoingEmail } from "./mailbox";

export interface GmailConfig {
  /** The bot account's address — it sends the turns and receives replies. */
  user: string;
  /** A Google App Password for that account (needs 2-Step Verification). */
  appPassword: string;
  /** The only address whose replies count. */
  playerEmail: string;
  /** Require Gmail's own DMARC pass verdict on replies (anti-spoofing). */
  requireDmarc: boolean;
  /** Display name on outgoing mail. */
  fromName: string;
}

const IMAP_HOST = "imap.gmail.com";
const SMTP_HOST = "smtp.gmail.com";
const DAY_MS = 24 * 60 * 60 * 1000;

function sameAddress(a: string | undefined, b: string): boolean {
  return (a ?? "").trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * True when the *topmost* Authentication-Results header — the one Gmail's
 * own receiving server (authserv-id mx.google.com) prepended on delivery —
 * reports `dmarc=pass` for the player's own domain. Lower headers are
 * ignored: anything below Gmail's could have been written by the sender.
 */
export function dmarcPassed(
  headerLines: readonly { key: string; line: string }[],
  playerEmail: string,
): boolean {
  const first = headerLines.find((h) => h.key.toLowerCase() === "authentication-results");
  if (!first) return false;
  const value = first.line.replace(/^[^:]*:\s*/, "").replace(/\s+/g, " ");
  if (!/^mx\.google\.com\s*;/i.test(value)) return false;
  const domain = playerEmail.split("@")[1]?.trim().toLowerCase();
  const verdict = /\bdmarc=pass\b[^;]*?\bheader\.from=([^\s;)]+)/i.exec(value);
  return Boolean(domain && verdict && verdict[1].toLowerCase() === domain);
}

/** The bot Gmail account: IMAP to read the player's replies, SMTP to send turns. */
export function createGmailMailbox(config: GmailConfig): Mailbox {
  const imapClient = () =>
    new ImapFlow({
      host: IMAP_HOST,
      port: 993,
      secure: true,
      auth: { user: config.user, pass: config.appPassword },
      logger: false,
    });

  return {
    async fetchReplies(since) {
      const client = imapClient();
      await client.connect();
      try {
        const lock = await client.getMailboxLock("INBOX");
        try {
          // IMAP SINCE is date-only (and server-timezone), so search a day
          // wide and filter on the exact internal date below.
          const uids = await client.search(
            { from: config.playerEmail, since: new Date(since.getTime() - DAY_MS) },
            { uid: true },
          );
          if (!uids || uids.length === 0) return [];
          const messages = await client.fetchAll(
            uids,
            { uid: true, source: true, internalDate: true },
            { uid: true },
          );

          const replies: IncomingReply[] = [];
          for (const msg of messages) {
            if (!msg.source) continue;
            const receivedAt = new Date(msg.internalDate ?? 0);
            if (!(receivedAt > since)) continue;
            const parsed = await simpleParser(msg.source);
            // IMAP FROM is a substring match; insist on the exact address.
            if (!sameAddress(parsed.from?.value[0]?.address, config.playerEmail)) continue;
            const authenticated = dmarcPassed(parsed.headerLines, config.playerEmail);
            if (config.requireDmarc && !authenticated) {
              console.warn(
                `gmail: ignoring reply uid ${msg.uid} — no DMARC pass for ${config.playerEmail}`,
              );
              continue;
            }
            replies.push({
              messageId: parsed.messageId ?? `<uid-${msg.uid}@imap.gmail.com>`,
              receivedAt,
              text: parsed.text ?? "",
              authenticated,
              uid: msg.uid,
            });
          }
          return replies.sort((a, b) => a.receivedAt.getTime() - b.receivedAt.getTime());
        } finally {
          lock.release();
        }
      } finally {
        await client.logout();
      }
    },

    async markProcessed(replies) {
      if (replies.length === 0) return;
      const client = imapClient();
      await client.connect();
      try {
        const lock = await client.getMailboxLock("INBOX");
        try {
          await client.messageFlagsAdd(
            replies.map((r) => r.uid),
            ["\\Seen"],
            { uid: true },
          );
        } finally {
          lock.release();
        }
      } finally {
        await client.logout();
      }
    },

    async send(email: OutgoingEmail) {
      const transport = nodemailer.createTransport({
        host: SMTP_HOST,
        port: 465,
        secure: true,
        auth: { user: config.user, pass: config.appPassword },
      });
      try {
        await transport.sendMail({
          from: { name: config.fromName, address: config.user },
          to: config.playerEmail,
          subject: email.subject,
          text: email.text,
          html: email.html,
          messageId: email.messageId,
          headers: { "X-Daily-Dungeon": "turn" },
        });
      } finally {
        transport.close();
      }
    },
  };
}
