import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { createGemini } from "./ai/gemini";
import { loadStateConfig, loadTickConfig, readAi, readSchedule } from "./config";
import { createGmailMailbox } from "./mail/gmail";
import { memoryMailbox } from "./mail/memory-mailbox";
import { encryptedFileStore, plainFileStore, validateGameFile } from "./store/state-file";
import { tick, type TickResult } from "./tick";

const HELP = `Daily Dungeon: solo D&D by email.

  pnpm tick [--force] [--dry-run] [--now <ISO time>]
      The daily run (GitHub Actions calls it hourly; it only acts once a day,
      at or after DELIVERY_TIME). --force runs now regardless; --dry-run reads
      the inbox and prints the email without sending or saving anything.
      Needs GMAIL_USER, GMAIL_APP_PASSWORD, PLAYER_EMAIL, STATE_ENCRYPTION_KEY
      (GEMINI_API_KEY optional: without it replies are read by keyword).

  pnpm preview [--reply "<your move>"] [--offline] [--reset] [--state <file>] [--out <dir>]
      Play locally against a plaintext state file (default out/preview-state.json),
      writing each email to <out> (default out/) as .html and .txt. Never touches
      Gmail. --offline skips Gemini even if GEMINI_API_KEY is set.

  pnpm state show | decrypt <file> | encrypt <file> | edit
      Inspect or fix the encrypted game (STATE_ENCRYPTION_KEY, STATE_DIR).

Settings are read from the environment, and from ./.env if present.`;

async function runTick(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      force: { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      now: { type: "string" },
    },
  });
  const config = loadTickConfig();
  const now = values.now ? new Date(values.now) : new Date();
  if (Number.isNaN(now.getTime())) throw new Error(`--now "${values.now}" isn't a date`);
  if (!config.geminiApiKey) {
    console.log(
      "GEMINI_API_KEY isn't set: replies are read by keyword and turns use plain engine text.",
    );
  }

  const result = await tick(
    {
      store: encryptedFileStore(config.stateDir, config.stateKey),
      mailbox: createGmailMailbox({
        user: config.gmailUser,
        appPassword: config.gmailAppPassword,
        playerEmail: config.playerEmail,
        requireDmarc: config.requireDmarc,
        fromName: "Daily Dungeon",
      }),
      model: config.geminiApiKey
        ? createGemini({ apiKey: config.geminiApiKey, model: config.geminiModel })
        : null,
      now,
      timeZone: config.timeZone,
      deliveryTime: config.deliveryTime,
      log: (m) => console.log(m),
    },
    { force: values.force, dryRun: values["dry-run"] },
  );

  if (values["dry-run"] && result.email) {
    console.log(`\n--- ${result.email.subject} ---\n${result.email.text}`);
  }
  console.log(describe(result));
}

function describe(result: TickResult): string {
  const what =
    result.status === "sent" ? `sent ${result.kind} email "${result.subject}"` : result.status;
  return `Result: ${what}${result.saved ? "; state saved" : ""}.`;
}

async function runPreview(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      reply: { type: "string" },
      offline: { type: "boolean", default: false },
      reset: { type: "boolean", default: false },
      state: { type: "string", default: path.join("out", "preview-state.json") },
      out: { type: "string", default: "out" },
    },
  });
  const statePath = values.state!;
  const outDir = values.out!;
  if (values.reset) await rm(statePath, { force: true });

  const store = plainFileStore(statePath);
  const mailbox = memoryMailbox();
  const ai = readAi(process.env);
  const model =
    !values.offline && ai.geminiApiKey
      ? createGemini({ apiKey: ai.geminiApiKey, model: ai.geminiModel })
      : null;
  let schedule = { timeZone: "UTC", deliveryTime: "07:00" };
  try {
    schedule = readSchedule(process.env);
  } catch {
    // Previews don't care about a misconfigured schedule; use the defaults.
  }
  console.log(
    model ? "Using Gemini to read and narrate." : "Offline: keyword parser, plain engine text.",
  );

  const deps = (now: Date) => ({
    store,
    mailbox,
    model,
    now,
    ...schedule,
    log: (m: string) => console.log(`  ${m}`),
  });
  await mkdir(outDir, { recursive: true });
  const save = async (result: TickResult) => {
    if (!result.email || !result.kind) return;
    const game = await store.load();
    const turn = String(game?.play.gameState.turnCount ?? 0).padStart(2, "0");
    const base = path.join(outDir, `${turn}-${result.kind}`);
    await writeFile(`${base}.html`, result.email.html);
    await writeFile(`${base}.txt`, result.email.text);
    console.log(`\n${result.email.subject}\n  → ${base}.html (and .txt)`);
  };

  if (!(await store.load())) {
    await save(await tick(deps(new Date()), { force: true }));
  }
  if (values.reply !== undefined) {
    mailbox.receive(values.reply, new Date(Date.now() + 1000), `<preview-${Date.now()}@local>`);
    await save(await tick(deps(new Date(Date.now() + 2000)), { force: true }));
  }
}

async function runState(args: string[]): Promise<void> {
  const [sub, file] = args;
  const config = loadStateConfig();
  const store = encryptedFileStore(config.stateDir, config.stateKey);

  switch (sub) {
    case "show": {
      const game = await store.load();
      console.log(game ? JSON.stringify(game, null, 2) : `No game saved at ${store.location} yet.`);
      return;
    }
    case "decrypt": {
      if (!file) throw new Error("Usage: pnpm state decrypt <output.json>");
      const game = await store.load();
      if (!game) throw new Error(`No game saved at ${store.location}.`);
      await writeFile(file, `${JSON.stringify(game, null, 2)}\n`);
      console.log(`Wrote plaintext state to ${file}. Don't commit it.`);
      return;
    }
    case "encrypt": {
      if (!file) throw new Error("Usage: pnpm state encrypt <input.json>");
      await store.save(validateGameFile(JSON.parse(await readFile(file, "utf8"))));
      console.log(`Encrypted ${file} into ${store.location}.`);
      return;
    }
    case "edit": {
      const game = await store.load();
      if (!game) throw new Error(`No game saved at ${store.location}.`);
      const tmp = path.join(tmpdir(), `dailydungeon-state-${process.pid}.json`);
      await writeFile(tmp, `${JSON.stringify(game, null, 2)}\n`);
      try {
        const editor = process.env.VISUAL || process.env.EDITOR || "vi";
        const run = spawnSync(editor, [tmp], { stdio: "inherit", shell: true });
        if (run.status !== 0)
          throw new Error(`${editor} exited with status ${run.status}; nothing saved.`);
        await store.save(validateGameFile(JSON.parse(await readFile(tmp, "utf8"))));
        console.log(`Saved your edits to ${store.location}.`);
      } finally {
        await rm(tmp, { force: true });
      }
      return;
    }
    default:
      throw new Error("Usage: pnpm state show | decrypt <file> | encrypt <file> | edit");
  }
}

async function main(argv: string[]): Promise<void> {
  if (existsSync(".env")) process.loadEnvFile(".env");
  const [command, ...rest] = argv;
  switch (command) {
    case "tick":
      return runTick(rest);
    case "preview":
      return runPreview(rest);
    case "state":
      return runState(rest);
    case undefined:
    case "help":
    case "--help":
      console.log(HELP);
      return;
    default:
      console.log(HELP);
      throw new Error(`Unknown command "${command}".`);
  }
}

main(process.argv.slice(2)).catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
