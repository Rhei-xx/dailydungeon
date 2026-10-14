import { describe, expect, it } from "vitest";
import { REPLY_MARKER, extractReplyText } from "./reply-text";

describe("extractReplyText", () => {
  it("cuts a Gmail reply at its 'On … wrote:' line", () => {
    const body = [
      "I attack the closest rat with my greataxe.",
      "",
      "On Sat, Oct 11, 2026 at 7:03 AM Daily Dungeon <dungeon.bot@gmail.com> wrote:",
      "",
      `> ${REPLY_MARKER}`,
      "> Day 3 — The Tower Entry",
    ].join("\n");
    expect(extractReplyText(body)).toBe("I attack the closest rat with my greataxe.");
  });

  it("handles Gmail hard-wrapping a long attribution line", () => {
    const body = [
      "Sneak past and go east. Stealth 14.",
      "",
      "On Sat, Oct 11, 2026 at 7:03 AM Daily Dungeon <",
      "dungeon.bot@gmail.com> wrote:",
      "",
      "> stuff",
    ].join("\n");
    expect(extractReplyText(body)).toBe("Sneak past and go east. Stealth 14.");
  });

  it("cuts an Apple Mail reply and drops 'Sent from my iPhone'", () => {
    const body = [
      "Drink a potion",
      "",
      "Sent from my iPhone",
      "",
      "On Oct 11, 2026, at 7:03 AM, Daily Dungeon <dungeon.bot@gmail.com> wrote:",
      "",
      "> quoted",
    ].join("\n");
    expect(extractReplyText(body)).toBe("Drink a potion");
  });

  it("cuts an Outlook reply at its From/Sent header block", () => {
    const body = [
      "Search the room please",
      "",
      "________________________________",
      "From: Daily Dungeon <dungeon.bot@gmail.com>",
      "Sent: Saturday, October 11, 2026 7:03 AM",
      "To: me@example.com",
      "Subject: Daily Dungeon · Day 3",
    ].join("\r\n");
    expect(extractReplyText(body)).toBe("Search the room please");

    const noSeparator = [
      "Search",
      "From: Daily Dungeon <x@gmail.com>",
      "Date: today",
      "Subject: hi",
    ].join("\n");
    expect(extractReplyText(noSeparator)).toBe("Search");
  });

  it("stops at our marker even when the client quotes without '>'", () => {
    expect(extractReplyText(`Go north\n\n${REPLY_MARKER}\nDay 4`)).toBe("Go north");
  });

  it("keeps a multi-line move and drops a '-- ' signature", () => {
    const body = "Attack the goblin.\nTo hit 17, damage 9.\n\n-- \nRhei";
    expect(extractReplyText(body)).toBe("Attack the goblin.\nTo hit 17, damage 9.");
  });

  it("doesn't mistake an ordinary sentence starting with 'On' for an attribution", () => {
    expect(extractReplyText("On second thought, I flee north.")).toBe(
      "On second thought, I flee north.",
    );
  });

  it("caps very long replies", () => {
    expect(extractReplyText("a".repeat(5000))).toHaveLength(2000);
  });
});
