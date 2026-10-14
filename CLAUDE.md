# Daily Dungeon — CLAUDE.md

## Vision

A **personal** solo Dungeons & Dragons game played over email, one turn a day, for one
player: the owner of this fork. Each morning an email arrives with what happened, where the
hero stands and what's in the room. The player replies in plain words and the next morning's
email plays that reply.

This repo is a fork of [Daily Scribe](https://github.com/RonanOD/dailyscribe), a
multi-tenant SaaS that emails Kindle Scribe owners daily PDFs and reads back their
handwriting. The owner has no Kindle Scribe, so the fork keeps Daily Scribe's DnD engine and
replaces everything else with a plain email loop. The SaaS parts (Next.js apps, Auth.js,
MongoDB, Resend, Vercel, marketing site, PDF and handwriting code, the other services) were
deliberately removed; they live in git history if ever needed.

## Decisions (from the owner's interview, Oct 2026)

| Topic          | Decision                                                                                                           |
| -------------- | ------------------------------------------------------------------------------------------------------------------ |
| Content        | DnD solo campaign only (the built-in _Sunken Vault_).                                                              |
| Replies        | Free text, parsed by **Gemini** into a structured move; keyword fallback.                                          |
| Email          | HTML body plus a plain-text part. No PDF, no attachments, no images or SVG.                                        |
| Mail transport | A **dedicated bot Gmail** account: SMTP to send, IMAP to read replies, app password. No domain needed.             |
| Hosting        | **GitHub Actions** (hourly cron; the script decides if it's due). Proof of concept; a home Docker box comes later. |
| Pacing         | **One turn per day** at `DELIVERY_TIME` in `TIMEZONE`. The latest reply wins. A forced run plays immediately.      |
| Dice           | **Mix.** Player-typed totals are used as given; missing rolls are engine-rolled; monsters always roll.             |
| Narration      | Gemini writes the outcome as a short paragraph; the engine stays authoritative. Fallback is the engine's own text. |
| State          | One JSON doc, **AES-256-GCM encrypted** (the repo is a public fork), committed to the `game-state` branch.         |
| Quiet days     | Nothing sent while waiting; one reminder after 3 quiet days.                                                       |

## Architecture

```
GitHub Actions (hourly) → pnpm tick → due today? → IMAP: replies from PLAYER_EMAIL since last email
  → strip quoted text → Gemini parse (→ keyword fallback) → engine (seeded dice)
  → Gemini narrate (→ plain fallback) → render HTML+text → SMTP send → save encrypted state
  → workflow commits state/state.json.enc to the game-state branch
```

- `src/engine/` — pure and deterministic. **Never** call `Math.random` here: all randomness
  goes through `Dice` (`seededDice(seed)` in production, `scriptedDice` in tests). The seed
  is `campaignId|turnCount|replyMessageId`, so a retried run replays identically.
- `src/ai/` — `TextModel` interface over `@google/genai`. `reconcileParsed` treats model
  output as untrusted: everything is type/range-checked, and the intent is forced to fit the
  game state. `restart` needs the literal word (restart, new character or start over) in the reply.
- `src/mail/` — the `Mailbox` interface (Gmail impl + in-memory impl). Only replies from the
  exact `PLAYER_EMAIL` with Gmail's own topmost `Authentication-Results` saying `dmarc=pass`
  count (`REQUIRE_DMARC=false` disables the DMARC part). Outgoing Message-IDs are
  deterministic (`messageIdFor`), so Gmail collapses a duplicate send from a retry.
- `src/email/` — hand-built tables plus inline CSS (Gmail-safe). Every email starts with
  `REPLY_MARKER`, which `extractReplyText` uses to cut quoted history.
- `src/store/` — `GameFile` (schemaVersion 1): `campaignId`, `play`, `mail` bookkeeping,
  `history`. **No email addresses or secrets in state**: they come from env only.
- `src/tick.ts` — the daily run. It **sends before saving**: a failure leaves the saved game
  untouched and the next hourly run retries.
- `src/cli.ts` — `pnpm tick | preview | state`. Loads `./.env` if present.

Config (env): `GMAIL_USER`, `GMAIL_APP_PASSWORD`, `PLAYER_EMAIL`, `STATE_ENCRYPTION_KEY`
(required for `tick`); `GEMINI_API_KEY`, `GEMINI_MODEL`, `TIMEZONE`, `DELIVERY_TIME`,
`REQUIRE_DMARC`, `STATE_DIR` (optional). See `SETUP.md` and `.env.example`.

## Working on it

- `pnpm test`, `pnpm typecheck` and `pnpm format:check` must pass. The engine, parser
  reconciliation, reply stripping, rendering (text snapshots), state and `tick` (with fakes)
  are all unit-tested.
- Look at email changes with `pnpm preview --offline --reply "..."` (writes `out/*.html`).
- Dependencies are pinned to releases at least two weeks old.
- Keep the AGPL `LICENSE` and the Daily Scribe attribution.

## Roadmap

- [x] **Proof of concept on GitHub Actions** — strip the SaaS, text-reply engine with
      seeded dice, Gmail IMAP/SMTP, Gemini parse + narrate, HTML emails, encrypted state
      on `game-state`, hourly workflow. _(Oct 2026; awaiting the owner's live setup.)_
- [ ] **Live verification** — the owner sets up the bot Gmail, secrets and Actions, and
      plays a few real turns (see the SETUP.md checklist).
- [ ] **Home Docker box** — run `pnpm tick` from cron in a container with `STATE_DIR` on
      a volume (no git commit step).
- [ ] **Balance pass** — engine-rolled monster attacks make level-1 fights lethal (two giant
      rats can down an 11 HP hero by turn 3, and 0 HP is instant death). Consider death
      saves, rage/second wind, or gentler first encounters.
- [ ] **More adventures** — the _Sunken Vault_ is six rooms (~1–3 weeks at a turn a day):
      more hand-written campaigns, or generated ones.

## Working agreements

- Decisions and current focus that aren't obvious from the code live in this file. Keep the
  roadmap checkboxes current as work lands.
