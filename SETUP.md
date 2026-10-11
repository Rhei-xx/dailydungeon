# Daily Dungeon — setup

About 15 minutes, once. You need a GitHub account (this repo), a Gmail account for the bot,
and optionally a Google AI Studio key.

## 1. A bot Gmail account

The game sends from, and reads replies at, its **own** Gmail account. Your personal inbox's
password is never stored anywhere.

1. Create a new Google account, e.g. `yourname.dungeon@gmail.com`.
2. Turn on **2-Step Verification** for it (Google Account → Security).
3. Create an **App Password** at <https://myaccount.google.com/apppasswords> (name it
   "Daily Dungeon"). Copy the 16-character password; spaces don't matter.
4. IMAP is on by default for Gmail. If the account's **Settings → Forwarding and POP/IMAP**
   shows IMAP disabled, enable it.

## 2. Your address

`PLAYER_EMAIL` is where turns go, and the only address whose replies count. Replies must
also carry a **DMARC pass**, which Gmail checks on arrival, so a forged "From: you" is
ignored. Gmail, Outlook, iCloud and most providers pass. If your replies are ignored and
the run log says `no DMARC pass`, set the variable `REQUIRE_DMARC` to `false`.

## 3. Optional: a Gemini key

Get one at <https://aistudio.google.com/apikey>. It lets you reply in free text and adds
narration. The game makes about two short calls a day, well inside the free tier. Without a
key, replies are read by keyword (attack / sneak / flee / dodge, exit names, potion, search,
numbers next to "to hit", "damage" and so on).

## 4. An encryption key

This repo is a public fork, so the saved game is encrypted before it's committed.

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

**Save it in your password manager.** Without it the saved game can't be read.

## 5. GitHub settings

In the repo: **Settings → Secrets and variables → Actions**.

**Secrets** (stay hidden in logs):

| Name                   | Value               |
| ---------------------- | ------------------- |
| `GMAIL_USER`           | the bot address     |
| `GMAIL_APP_PASSWORD`   | its app password    |
| `PLAYER_EMAIL`         | your address        |
| `STATE_ENCRYPTION_KEY` | the key from step 4 |
| `GEMINI_API_KEY`       | optional            |

**Variables:**

| Name            | Example               | Default               |
| --------------- | --------------------- | --------------------- |
| `TIMEZONE`      | `America/Toronto`     | `UTC`                 |
| `DELIVERY_TIME` | `07:00`               | `07:00`               |
| `GEMINI_MODEL`  | `gemini-flash-latest` | `gemini-flash-latest` |
| `REQUIRE_DMARC` | `false`               | `true`                |

## 6. Turn it on

1. **Actions tab → "I understand my workflows, go ahead and enable them".** A fork starts
   with Actions disabled.
2. **Merge this work into `main`.** Scheduled workflows only run from the default branch.
3. **Actions → daily-turn → Run workflow**, tick **force**, run it.
4. A "Create your hero" email should arrive within a minute. Check spam the first time, and
   mark it _Not spam_ or add the bot to your contacts.
5. Reply with a name and a class, e.g. `Brakka, barbarian`. Your hero arrives at the next
   delivery time, or right away if you run the workflow with **force** again.

From then on the workflow runs hourly and plays one turn per day at `DELIVERY_TIME`.

## Living with it

- **Play faster:** run the workflow with **force** after replying (the GitHub mobile app
  can do this). Each forced run plays your latest reply.
- **See the saved game:**
  ```bash
  git fetch origin game-state
  git worktree add state game-state      # once; later: git -C state pull
  STATE_ENCRYPTION_KEY=... pnpm state show
  ```
  `pnpm state edit` opens it in `$EDITOR` and re-encrypts it. Commit and push from `state/`
  to `game-state` to make the change stick.
- **Undo a turn:** `git -C state revert HEAD && git -C state push origin HEAD:game-state`.
  The reverted reply becomes unplayed again, and the same dice would replay it the same
  way, so reply with a different move before the next run (the latest reply wins).
- **Dry run against the real inbox:** put the same settings in a local `.env` (see
  `.env.example`), then `pnpm tick --dry-run --force`. It prints the email it would send
  and changes nothing.
- **Play offline:** `pnpm preview --offline --reply "..."` writes each email to `out/` as
  HTML and text. It never touches Gmail or the real game.

## Troubleshooting

- **No email.** Open the latest **daily-turn** run. `Not due` means it isn't delivery time
  yet, or today's turn already ran; use **force**. A configuration error names the missing
  secret. A Gmail login error means the app password is wrong, or 2-Step Verification was
  turned off.
- **Reply ignored.** It must come from `PLAYER_EMAIL` exactly, arrive after the last email,
  and pass DMARC (see step 2). The run log says how many replies it read.
- **"Gemini read failed" in the log.** The turn falls back to the keyword reader. Check the
  key or quota.
- **Schedule stopped.** GitHub pauses schedules on public repos after 60 days without
  activity, and emails a warning first. Daily state commits keep it active while you play;
  re-enable it from the Actions tab.

## Later: run it at home

`pnpm tick` doesn't depend on GitHub. On an always-on machine, run it hourly from cron (or
a container) with the same environment and `STATE_DIR` on a persistent volume. The git
commit step simply goes away.
