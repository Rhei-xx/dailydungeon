import { GoogleGenAI, type Schema } from "@google/genai";

/** Google's self-updating alias for the current Flash model. Two short calls
 *  a day (parse the reply, narrate the result) sit well inside the free tier. */
export const DEFAULT_GEMINI_MODEL = "gemini-flash-latest";

/** Tried when the main model keeps failing. The live game hit days of 503
 *  "high demand" errors from Flash; the lighter model is a separate capacity
 *  pool and is plenty for reading a one-line move. */
export const DEFAULT_GEMINI_FALLBACK_MODEL = "gemini-flash-lite-latest";

const TIMEOUT_MS = 30_000;

/** Wait before retrying the same model after a transient failure. One retry
 *  per model keeps a bad day to about two minutes per call, well inside the
 *  workflow's time limit. */
const RETRY_DELAYS_MS = [4_000];

/** The two kinds of call the game makes — kept behind an interface so the
 *  parser and narrator can be tested with canned responses. */
export interface TextModel {
  /** Structured output: the raw response text, expected to be JSON matching `schema`. */
  json(opts: { system: string; prompt: string; schema: Schema }): Promise<string>;
  /** Free prose. */
  text(opts: { system: string; prompt: string }): Promise<string>;
}

/** Every model and retry failed. `transient` is true when every failure was
 *  the kind that clears up on its own (overload, rate limit, timeout), so the
 *  caller may reasonably try again later rather than make do without AI. */
export class AiUnavailableError extends Error {
  constructor(
    message: string,
    readonly transient: boolean,
  ) {
    super(message);
    this.name = "AiUnavailableError";
  }
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Overloaded, rate-limited, timed out or unreachable: worth another try. */
export function isTransientAiError(err: unknown): boolean {
  const status = (err as { status?: unknown } | null)?.status;
  if (typeof status === "number") return status === 408 || status === 429 || status >= 500;
  const text = err instanceof Error ? `${err.name} ${err.message}` : String(err);
  return /abort|time(d)? ?out|UNAVAILABLE|RESOURCE_EXHAUSTED|overloaded|high demand|"code":\s*(429|5\d\d)|fetch failed|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up/i.test(
    text,
  );
}

/**
 * Run `call` against each model in turn. A transient failure is retried on
 * the same model after a short wait; anything else, or running out of
 * retries, moves on to the next model. Throws AiUnavailableError if nothing
 * worked.
 */
export async function callWithFallback<T>(
  models: string[],
  call: (model: string) => Promise<T>,
  opts: {
    delaysMs?: number[];
    sleep?: (ms: number) => Promise<void>;
    log?: (message: string) => void;
  } = {},
): Promise<T> {
  const delays = opts.delaysMs ?? RETRY_DELAYS_MS;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const log = opts.log ?? ((m: string) => console.warn(m));
  let lastError: unknown;
  let allTransient = true;
  for (const model of models) {
    for (let attempt = 0; attempt <= delays.length; attempt++) {
      try {
        return await call(model);
      } catch (err) {
        lastError = err;
        const transient = isTransientAiError(err);
        if (!transient) allTransient = false;
        log(`gemini: ${model} attempt ${attempt + 1} failed: ${describeError(err)}`);
        if (!transient || attempt === delays.length) break;
        await sleep(delays[attempt]);
      }
    }
  }
  throw new AiUnavailableError(
    `Gemini unavailable (tried ${models.join(", ")}): ${describeError(lastError)}`,
    allTransient,
  );
}

export interface GeminiConfig {
  apiKey: string;
  model?: string;
  /** Tried after `model` fails; "none" turns the fallback off. */
  fallbackModel?: string;
}

export function geminiModels(config: Pick<GeminiConfig, "model" | "fallbackModel">): string[] {
  const primary = config.model || DEFAULT_GEMINI_MODEL;
  const fallback = config.fallbackModel || DEFAULT_GEMINI_FALLBACK_MODEL;
  return fallback === "none" || fallback === primary ? [primary] : [primary, fallback];
}

/** Thin wrapper around GoogleGenAI — not unit-tested; the retry/fallback
 *  logic and everything that interprets its output are (callWithFallback,
 *  parse-reply.ts, narrate.ts). */
export function createGemini(config: GeminiConfig): TextModel {
  const ai = new GoogleGenAI({ apiKey: config.apiKey });
  const models = geminiModels(config);
  return {
    json({ system, prompt, schema }) {
      return callWithFallback(models, async (model) => {
        const response = await ai.models.generateContent({
          model,
          contents: prompt,
          config: {
            systemInstruction: system,
            temperature: 0,
            responseMimeType: "application/json",
            responseSchema: schema,
            abortSignal: AbortSignal.timeout(TIMEOUT_MS),
          },
        });
        return response.text ?? "";
      });
    },
    text({ system, prompt }) {
      return callWithFallback(models, async (model) => {
        const response = await ai.models.generateContent({
          model,
          contents: prompt,
          config: {
            systemInstruction: system,
            temperature: 0.9,
            abortSignal: AbortSignal.timeout(TIMEOUT_MS),
          },
        });
        const text = response.text ?? "";
        if (!text.trim()) throw new Error("empty response");
        return text;
      });
    },
  };
}

/** Models sometimes wrap JSON in a ```json fence despite responseMimeType. */
export function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith("```")) return trimmed;
  return trimmed
    .replace(/^```[a-zA-Z]*\n?/, "")
    .replace(/```\s*$/, "")
    .trim();
}
