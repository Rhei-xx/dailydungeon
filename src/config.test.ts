import { describe, expect, it } from "vitest";
import { loadStateConfig, loadTickConfig } from "./config";
import { isDue, localParts } from "./time";

const KEY = Buffer.alloc(32, 7).toString("base64");
const GOOD = {
  GMAIL_USER: "dungeon.bot@gmail.com",
  GMAIL_APP_PASSWORD: "abcd efgh ijkl mnop",
  PLAYER_EMAIL: "me@example.com",
  STATE_ENCRYPTION_KEY: KEY,
};

describe("loadTickConfig", () => {
  it("reads a complete environment, with sensible defaults", () => {
    expect(loadTickConfig(GOOD)).toMatchObject({
      gmailAppPassword: "abcdefghijklmnop", // Google's display spaces removed
      timeZone: "UTC",
      deliveryTime: "07:00",
      stateDir: "state",
      requireDmarc: true,
      geminiApiKey: undefined,
    });
  });

  it("lists every problem at once, treating empty strings as unset", () => {
    expect(() =>
      loadTickConfig({ GMAIL_USER: "", TIMEZONE: "Mars/Olympus", DELIVERY_TIME: "25:00" }),
    ).toThrow(
      /GMAIL_USER is not set[\s\S]*GMAIL_APP_PASSWORD[\s\S]*PLAYER_EMAIL[\s\S]*STATE_ENCRYPTION_KEY[\s\S]*TIMEZONE[\s\S]*DELIVERY_TIME/,
    );
  });

  it("normalises the delivery time and honours REQUIRE_DMARC=false", () => {
    const config = loadTickConfig({
      ...GOOD,
      DELIVERY_TIME: "7:30",
      TIMEZONE: "Europe/Dublin",
      REQUIRE_DMARC: "false",
    });
    expect(config).toMatchObject({
      deliveryTime: "07:30",
      timeZone: "Europe/Dublin",
      requireDmarc: false,
    });
  });

  it("rejects a bot address that is also the player's", () => {
    expect(() => loadTickConfig({ ...GOOD, PLAYER_EMAIL: "Dungeon.Bot@gmail.com" })).toThrow(
      /must differ/,
    );
  });

  it("rejects a key that isn't 32 bytes", () => {
    expect(() => loadStateConfig({ STATE_ENCRYPTION_KEY: "c2hvcnQ=" })).toThrow(/exactly 32 bytes/);
  });
});

describe("isDue", () => {
  it("is due at or after the local delivery time, once per local date", () => {
    // 2026-10-11 10:59Z is 06:59 in Toronto (EDT).
    expect(isDue(new Date("2026-10-11T10:59:00Z"), "America/Toronto", "07:00", undefined)).toBe(
      false,
    );
    expect(isDue(new Date("2026-10-11T11:00:00Z"), "America/Toronto", "07:00", undefined)).toBe(
      true,
    );
    expect(isDue(new Date("2026-10-11T23:00:00Z"), "America/Toronto", "07:00", "2026-10-11")).toBe(
      false,
    );
  });

  it("follows daylight saving without any schedule change", () => {
    // After the November switch to EST (UTC-5), 07:00 local is 12:00Z.
    expect(localParts(new Date("2026-11-02T12:00:00Z"), "America/Toronto")).toEqual({
      isoDate: "2026-11-02",
      hhmm: "07:00",
    });
    expect(isDue(new Date("2026-11-02T11:30:00Z"), "America/Toronto", "07:00", "2026-11-01")).toBe(
      false,
    );
  });
});
