import { describe, expect, it } from "vitest";
import { dmarcPassed } from "./gmail";
import { messageIdFor } from "./mailbox";

const header = (line: string) => ({ key: "authentication-results", line });

describe("dmarcPassed", () => {
  const gmailVerdict = header(
    "Authentication-Results: mx.google.com;\r\n       dkim=pass header.i=@gmail.com header.s=20230601;\r\n" +
      "       spf=pass (google.com: domain of me@gmail.com designates 1.2.3.4 as permitted sender) smtp.mailfrom=me@gmail.com;\r\n" +
      "       dmarc=pass (p=NONE sp=QUARANTINE dis=NONE) header.from=gmail.com",
  );

  it("accepts Gmail's own DMARC pass for the player's domain", () => {
    expect(
      dmarcPassed([{ key: "received", line: "Received: ..." }, gmailVerdict], "me@gmail.com"),
    ).toBe(true);
  });

  it("rejects a DMARC failure, a pass for another domain, and a missing header", () => {
    const fail = header(
      "Authentication-Results: mx.google.com; dmarc=fail (p=NONE) header.from=gmail.com",
    );
    expect(dmarcPassed([fail], "me@gmail.com")).toBe(false);
    expect(dmarcPassed([gmailVerdict], "me@example.com")).toBe(false);
    expect(dmarcPassed([], "me@gmail.com")).toBe(false);
  });

  it("only trusts the topmost header, which Gmail itself added", () => {
    const forgedBelow = header(
      "Authentication-Results: mx.google.com; dmarc=pass header.from=gmail.com",
    );
    const realTop = header(
      "Authentication-Results: mx.google.com; dmarc=fail header.from=gmail.com",
    );
    expect(dmarcPassed([realTop, forgedBelow], "me@gmail.com")).toBe(false);
    const otherServer = header(
      "Authentication-Results: evil.example; dmarc=pass header.from=gmail.com",
    );
    expect(dmarcPassed([otherServer], "me@gmail.com")).toBe(false);
  });
});

describe("messageIdFor", () => {
  it("is stable for the same facts and different for different ones", () => {
    const base = { campaignId: "abc123", turn: 4, kind: "turn", replyId: "<r1@mail>" };
    expect(messageIdFor(base)).toBe(messageIdFor({ ...base }));
    expect(messageIdFor(base)).not.toBe(messageIdFor({ ...base, replyId: "<r2@mail>" }));
    expect(messageIdFor(base)).toMatch(/^<dd\.turn\.4\.[0-9a-f]{20}@dailydungeon\.invalid>$/);
  });
});
