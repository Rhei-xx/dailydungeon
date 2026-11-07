import { describe, expect, it, vi } from "vitest";
import { AiUnavailableError, callWithFallback, geminiModels, isTransientAiError } from "./gemini";

const overloaded = Object.assign(new Error('{"error":{"code":503,"status":"UNAVAILABLE"}}'), {
  status: 503,
});
const badRequest = Object.assign(new Error("model not found"), { status: 404 });
const noWait = { sleep: async () => {}, log: () => {} };

describe("isTransientAiError", () => {
  it("treats overload, rate limits and timeouts as transient", () => {
    expect(isTransientAiError(overloaded)).toBe(true);
    expect(isTransientAiError(Object.assign(new Error("slow down"), { status: 429 }))).toBe(true);
    // What the live game logged when a call hit the 30s timeout:
    expect(isTransientAiError(new Error("This operation was aborted"))).toBe(true);
    expect(isTransientAiError(new Error('{"error":{"code":503,"message":"high demand"}}'))).toBe(
      true,
    );
  });

  it("treats a bad request or bad key as permanent", () => {
    expect(isTransientAiError(badRequest)).toBe(false);
    expect(isTransientAiError(Object.assign(new Error("API key not valid"), { status: 400 }))).toBe(
      false,
    );
  });
});

describe("callWithFallback", () => {
  it("retries a transient failure on the same model, then succeeds", async () => {
    const call = vi.fn().mockRejectedValueOnce(overloaded).mockResolvedValueOnce("ok");
    await expect(callWithFallback(["flash", "lite"], call, noWait)).resolves.toBe("ok");
    expect(call.mock.calls.map((c) => c[0])).toEqual(["flash", "flash"]);
  });

  it("moves to the fallback model when the main one keeps failing", async () => {
    const call = vi.fn(async (model: string) => {
      if (model === "flash") throw overloaded;
      return "from lite";
    });
    await expect(callWithFallback(["flash", "lite"], call, noWait)).resolves.toBe("from lite");
    expect(call.mock.calls.map((c) => c[0])).toEqual(["flash", "flash", "lite"]);
  });

  it("doesn't retry a permanent error, but still tries the fallback model", async () => {
    const call = vi.fn(async (model: string) => {
      if (model === "flash") throw badRequest;
      return "from lite";
    });
    await expect(callWithFallback(["flash", "lite"], call, noWait)).resolves.toBe("from lite");
    expect(call.mock.calls.map((c) => c[0])).toEqual(["flash", "lite"]);
  });

  it("reports whether everything failed only transiently", async () => {
    const transient = callWithFallback(["a", "b"], async () => Promise.reject(overloaded), noWait);
    await expect(transient).rejects.toMatchObject({ name: "AiUnavailableError", transient: true });

    const mixed = callWithFallback(
      ["a", "b"],
      async (m) => Promise.reject(m === "a" ? overloaded : badRequest),
      noWait,
    );
    await expect(mixed).rejects.toBeInstanceOf(AiUnavailableError);
    await expect(mixed).rejects.toMatchObject({ transient: false });
  });
});

describe("geminiModels", () => {
  it("uses Flash then Flash-Lite by default, and honours overrides", () => {
    expect(geminiModels({})).toEqual(["gemini-flash-latest", "gemini-flash-lite-latest"]);
    expect(geminiModels({ model: "x", fallbackModel: "y" })).toEqual(["x", "y"]);
    expect(geminiModels({ model: "x", fallbackModel: "none" })).toEqual(["x"]);
    expect(geminiModels({ model: "gemini-flash-lite-latest" })).toEqual([
      "gemini-flash-lite-latest",
    ]);
  });
});
