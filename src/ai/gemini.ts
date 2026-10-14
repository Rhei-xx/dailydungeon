import { GoogleGenAI, type Schema } from "@google/genai";

/** Google's self-updating alias for the current Flash model. Two short calls
 *  a day (parse the reply, narrate the result) sit well inside the free tier. */
export const DEFAULT_GEMINI_MODEL = "gemini-flash-latest";

const TIMEOUT_MS = 30_000;

/** The two kinds of call the game makes — kept behind an interface so the
 *  parser and narrator can be tested with canned responses. */
export interface TextModel {
  /** Structured output: the raw response text, expected to be JSON matching `schema`. */
  json(opts: { system: string; prompt: string; schema: Schema }): Promise<string>;
  /** Free prose. */
  text(opts: { system: string; prompt: string }): Promise<string>;
}

export interface GeminiConfig {
  apiKey: string;
  model?: string;
}

/** Thin wrapper around GoogleGenAI — not unit-tested; everything that
 *  interprets its output is (see parse-reply.ts, narrate.ts). */
export function createGemini(config: GeminiConfig): TextModel {
  const ai = new GoogleGenAI({ apiKey: config.apiKey });
  const model = config.model || DEFAULT_GEMINI_MODEL;
  return {
    async json({ system, prompt, schema }) {
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
    },
    async text({ system, prompt }) {
      const response = await ai.models.generateContent({
        model,
        contents: prompt,
        config: {
          systemInstruction: system,
          temperature: 0.9,
          abortSignal: AbortSignal.timeout(TIMEOUT_MS),
        },
      });
      return response.text ?? "";
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
