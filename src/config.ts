/**
 * Settings come from the environment only: GitHub Actions secrets/variables
 * in CI, a local `.env` for the CLI. Nothing here is ever written to the
 * state file. Empty strings count as unset (an unset Actions variable
 * expands to "").
 */

type Env = Record<string, string | undefined>;

export interface StateConfig {
  /** base64 32-byte AES-256-GCM key. */
  stateKey: string;
  /** Directory holding state.json.enc (the game-state branch checkout in CI). */
  stateDir: string;
}

export interface ScheduleConfig {
  timeZone: string;
  /** Local "HH:MM" of the daily run. */
  deliveryTime: string;
}

export interface AiConfig {
  geminiApiKey?: string;
  geminiModel?: string;
}

export interface MailConfig {
  gmailUser: string;
  gmailAppPassword: string;
  playerEmail: string;
  requireDmarc: boolean;
}

export type TickConfig = StateConfig & ScheduleConfig & AiConfig & MailConfig;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function value(env: Env, name: string): string | undefined {
  const v = env[name]?.trim();
  return v ? v : undefined;
}

class ConfigErrors {
  readonly problems: string[] = [];
  require(env: Env, name: string, hint: string): string {
    const v = value(env, name);
    if (!v) this.problems.push(`${name} is not set — ${hint}`);
    return v ?? "";
  }
  check(ok: boolean, problem: string): void {
    if (!ok) this.problems.push(problem);
  }
  throwIfAny(): void {
    if (this.problems.length > 0) {
      throw new Error(
        `Configuration problem${this.problems.length > 1 ? "s" : ""}:\n- ${this.problems.join("\n- ")}`,
      );
    }
  }
}

function readState(env: Env, errors: ConfigErrors): StateConfig {
  const stateKey = errors.require(
    env,
    "STATE_ENCRYPTION_KEY",
    "generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\"",
  );
  if (stateKey) {
    errors.check(
      Buffer.from(stateKey, "base64").length === 32,
      "STATE_ENCRYPTION_KEY must be base64 for exactly 32 bytes",
    );
  }
  return { stateKey, stateDir: value(env, "STATE_DIR") ?? "state" };
}

export function readSchedule(env: Env, errors = new ConfigErrors()): ScheduleConfig {
  const timeZone = value(env, "TIMEZONE") ?? "UTC";
  try {
    new Intl.DateTimeFormat("en", { timeZone });
  } catch {
    errors.check(false, `TIMEZONE "${timeZone}" isn't an IANA timezone (e.g. America/Toronto)`);
  }
  const raw = value(env, "DELIVERY_TIME") ?? "07:00";
  const m = /^(\d{1,2}):(\d{2})$/.exec(raw);
  const ok = Boolean(m && Number(m[1]) <= 23 && Number(m[2]) <= 59);
  errors.check(ok, `DELIVERY_TIME "${raw}" must be a 24-hour HH:MM time, e.g. 07:00`);
  const deliveryTime = ok && m ? `${m[1].padStart(2, "0")}:${m[2]}` : "07:00";
  return { timeZone, deliveryTime };
}

export function readAi(env: Env): AiConfig {
  return { geminiApiKey: value(env, "GEMINI_API_KEY"), geminiModel: value(env, "GEMINI_MODEL") };
}

/** Just what the `state` commands need. */
export function loadStateConfig(env: Env = process.env): StateConfig {
  const errors = new ConfigErrors();
  const config = readState(env, errors);
  errors.throwIfAny();
  return config;
}

/** Everything the daily run needs; fails fast listing every problem at once. */
export function loadTickConfig(env: Env = process.env): TickConfig {
  const errors = new ConfigErrors();
  const gmailUser = errors.require(env, "GMAIL_USER", "the bot Gmail address that sends turns");
  // Google shows app passwords in groups of four ("abcd efgh ijkl mnop").
  const gmailAppPassword = errors
    .require(env, "GMAIL_APP_PASSWORD", "a Google App Password for the bot account")
    .replace(/\s+/g, "");
  const playerEmail = errors.require(
    env,
    "PLAYER_EMAIL",
    "your own address — the only one whose replies count",
  );
  if (gmailUser)
    errors.check(EMAIL_RE.test(gmailUser), `GMAIL_USER "${gmailUser}" isn't an email address`);
  if (playerEmail)
    errors.check(
      EMAIL_RE.test(playerEmail),
      `PLAYER_EMAIL "${playerEmail}" isn't an email address`,
    );
  if (gmailUser && playerEmail) {
    errors.check(
      gmailUser.toLowerCase() !== playerEmail.toLowerCase(),
      "GMAIL_USER and PLAYER_EMAIL must differ — the bot emails you, you reply to the bot",
    );
  }
  const state = readState(env, errors);
  const schedule = readSchedule(env, errors);
  const dmarc = value(env, "REQUIRE_DMARC")?.toLowerCase();
  errors.throwIfAny();
  return {
    gmailUser,
    gmailAppPassword,
    playerEmail,
    requireDmarc: !(dmarc === "false" || dmarc === "0" || dmarc === "no"),
    ...state,
    ...schedule,
    ...readAi(env),
  };
}
