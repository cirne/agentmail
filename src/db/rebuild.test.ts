import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { reindexFromMaildir } from "./rebuild";
import { getDb, closeDb } from "./index";
import { writeMessageMeta } from "~/lib/message-meta";

describe("reindexFromMaildir", () => {
  let testTempDir: string;
  let originalEnv: string | undefined;

  beforeEach(() => {
    testTempDir = mkdtempSync(join(tmpdir(), "zmail-rebuild-test-"));
    originalEnv = process.env.ZMAIL_HOME;
    process.env.ZMAIL_HOME = testTempDir;
    closeDb(); // Close any existing DB connection

    // Create maildir structure
    mkdirSync(join(testTempDir, "data", "maildir", "cur"), { recursive: true });
    mkdirSync(join(testTempDir, "data", "maildir", "attachments"), { recursive: true });
    
    // Create a minimal config.json so config loading doesn't fail
    mkdirSync(join(testTempDir), { recursive: true });
    writeFileSync(join(testTempDir, "config.json"), JSON.stringify({ imap: { host: "imap.gmail.com" } }));
  });

  afterEach(() => {
    closeDb();
    if (originalEnv !== undefined) {
      process.env.ZMAIL_HOME = originalEnv;
    } else {
      delete process.env.ZMAIL_HOME;
    }
    rmSync(testTempDir, { recursive: true, force: true });
  });

  it("reindexes messages from maildir/cur/", async () => {
    const maildirCur = join(testTempDir, "data", "maildir", "cur");

    // Create test EML files
    const eml1 = Buffer.from(
      `Message-ID: <test1@example.com>
From: alice@example.com
To: bob@example.com
Subject: Test Message 1
Date: Mon, 1 Jan 2024 12:00:00 +0000
Content-Type: text/plain

Hello, this is test message 1.`
    );
    writeFileSync(join(maildirCur, "100_test1@example.com.eml"), eml1);

    const eml2 = Buffer.from(
      `Message-ID: <test2@example.com>
From: bob@example.com
To: alice@example.com
Subject: Test Message 2
Date: Mon, 2 Jan 2024 12:00:00 +0000
Content-Type: text/plain

Hello, this is test message 2.`
    );
    writeFileSync(join(maildirCur, "200_test2@example.com.eml"), eml2);

    const result = await reindexFromMaildir();
    expect(result.parsed).toBe(2);
    expect(result.failed).toBe(0);

    const db = getDb();
    const messages = db.prepare("SELECT * FROM messages ORDER BY uid").all() as Array<{
      message_id: string;
      subject: string;
      from_address: string;
      body_text: string;
    }>;

    expect(messages.length).toBe(2);
    expect(messages[0].message_id).toBe("<test1@example.com>");
    expect(messages[0].subject).toBe("Test Message 1");
    expect(messages[0].from_address).toBe("alice@example.com");
    expect(messages[0].body_text).toContain("test message 1");

    expect(messages[1].message_id).toBe("<test2@example.com>");
    expect(messages[1].subject).toBe("Test Message 2");
    expect(messages[1].from_address).toBe("bob@example.com");
    expect(messages[1].body_text).toContain("test message 2");
  });

  it("creates FTS index entries", async () => {
    const maildirCur = join(testTempDir, "data", "maildir", "cur");

    const eml = Buffer.from(
      `Message-ID: <invoice@example.com>
From: billing@example.com
To: user@example.com
Subject: Invoice from Stripe
Date: Mon, 1 Jan 2024 12:00:00 +0000
Content-Type: text/plain

Your invoice is ready.`
    );
    writeFileSync(join(maildirCur, "300_invoice@example.com.eml"), eml);

    await reindexFromMaildir();

    const db = getDb();
    const ftsResults = db
      .prepare("SELECT message_id FROM messages_fts WHERE messages_fts MATCH 'Invoice'")
      .all() as Array<{ message_id: string }>;

    expect(ftsResults.length).toBe(1);
    expect(ftsResults[0].message_id).toBe("<invoice@example.com>");
  });

  it("skips files with invalid UID format", async () => {
    const maildirCur = join(testTempDir, "data", "maildir", "cur");

    // Valid file
    const eml1 = Buffer.from(
      `Message-ID: <valid@example.com>
From: test@example.com
To: test@example.com
Subject: Valid
Date: Mon, 1 Jan 2024 12:00:00 +0000
Content-Type: text/plain

Valid message.`
    );
    writeFileSync(join(maildirCur, "100_valid@example.com.eml"), eml1);

    // Invalid file (no UID prefix)
    const eml2 = Buffer.from(
      `Message-ID: <invalid@example.com>
From: test@example.com
To: test@example.com
Subject: Invalid
Date: Mon, 1 Jan 2024 12:00:00 +0000
Content-Type: text/plain

Invalid message.`
    );
    writeFileSync(join(maildirCur, "invalid@example.com.eml"), eml2);

    const result = await reindexFromMaildir();
    expect(result.parsed).toBe(1);
    expect(result.failed).toBe(1);

    const db = getDb();
    const messages = db.prepare("SELECT COUNT(*) as count FROM messages").get() as { count: number };
    expect(messages.count).toBe(1);
  });

  it("handles empty maildir gracefully", async () => {
    const result = await reindexFromMaildir();
    expect(result.parsed).toBe(0);
    expect(result.failed).toBe(0);
  });

  it("handles missing maildir/cur/ directory", async () => {
    // Remove cur directory
    rmSync(join(testTempDir, "data", "maildir", "cur"), { recursive: true, force: true });

    const result = await reindexFromMaildir();
    expect(result.parsed).toBe(0);
    expect(result.failed).toBe(0);
  });

  it("reads sidecar labels and classifies noise from Gmail categories", async () => {
    const maildirCur = join(testTempDir, "data", "maildir", "cur");

    const promoEml = Buffer.from(
      `Message-ID: <promo@example.com>
From: deals@store.com
To: user@example.com
Subject: Big Sale Today
Date: Mon, 1 Jan 2024 12:00:00 +0000
Content-Type: text/plain

50% off everything!`
    );
    const promoFile = join(maildirCur, "100_promo@example.com.eml");
    writeFileSync(promoFile, promoEml);
    writeMessageMeta(promoFile, { labels: ["\\Inbox", "Promotions"] });

    const normalEml = Buffer.from(
      `Message-ID: <normal@example.com>
From: colleague@company.com
To: user@example.com
Subject: Meeting Tomorrow
Date: Mon, 1 Jan 2024 13:00:00 +0000
Content-Type: text/plain

Let's meet at 2pm.`
    );
    const normalFile = join(maildirCur, "200_normal@example.com.eml");
    writeFileSync(normalFile, normalEml);
    writeMessageMeta(normalFile, { labels: ["\\Inbox", "\\Important"] });

    const noSidecarEml = Buffer.from(
      `Message-ID: <nosidecar@example.com>
From: other@example.com
To: user@example.com
Subject: No Sidecar
Date: Mon, 1 Jan 2024 14:00:00 +0000
Content-Type: text/plain

No sidecar file for this one.`
    );
    writeFileSync(join(maildirCur, "300_nosidecar@example.com.eml"), noSidecarEml);

    const result = await reindexFromMaildir();
    expect(result.parsed).toBe(3);

    const db = getDb();
    const promo = db.prepare("SELECT is_noise, labels FROM messages WHERE message_id = ?").get("<promo@example.com>") as any;
    expect(promo.is_noise).toBe(1);
    expect(JSON.parse(promo.labels)).toContain("Promotions");

    const normal = db.prepare("SELECT is_noise, labels FROM messages WHERE message_id = ?").get("<normal@example.com>") as any;
    expect(normal.is_noise).toBe(0);

    const noSidecar = db.prepare("SELECT is_noise, labels FROM messages WHERE message_id = ?").get("<nosidecar@example.com>") as any;
    expect(noSidecar.is_noise).toBe(0);
    expect(JSON.parse(noSidecar.labels)).toEqual([]);
  });

  it("classifies Superhuman AI marketing/news/social labels as noise", async () => {
    const maildirCur = join(testTempDir, "data", "maildir", "cur");

    const marketingEml = Buffer.from(
      `Message-ID: <marketing@example.com>
From: deals@nytimes.com
To: user@example.com
Subject: Special Offer
Date: Mon, 1 Jan 2024 12:00:00 +0000
Content-Type: text/plain

Subscribe now!`
    );
    const marketingFile = join(maildirCur, "100_marketing@example.com.eml");
    writeFileSync(marketingFile, marketingEml);
    writeMessageMeta(marketingFile, { labels: ["[Superhuman]/AI/AutoArchived", "[Superhuman]/AI/Marketing"] });

    const newsEml = Buffer.from(
      `Message-ID: <news@example.com>
From: newsletter@athletic.com
To: user@example.com
Subject: Sports News
Date: Mon, 1 Jan 2024 13:00:00 +0000
Content-Type: text/plain

Headlines today.`
    );
    const newsFile = join(maildirCur, "200_news@example.com.eml");
    writeFileSync(newsFile, newsEml);
    writeMessageMeta(newsFile, { labels: ["[Superhuman]/AI/AutoArchived", "[Superhuman]/AI/News"] });

    const respondEml = Buffer.from(
      `Message-ID: <respond@example.com>
From: boss@company.com
To: user@example.com
Subject: Need your input
Date: Mon, 1 Jan 2024 14:00:00 +0000
Content-Type: text/plain

Please review.`
    );
    const respondFile = join(maildirCur, "300_respond@example.com.eml");
    writeFileSync(respondFile, respondEml);
    writeMessageMeta(respondFile, { labels: ["[Superhuman]/AI/Respond", "\\Inbox"] });

    await reindexFromMaildir();

    const db = getDb();
    const marketing = db.prepare("SELECT is_noise FROM messages WHERE message_id = ?").get("<marketing@example.com>") as any;
    expect(marketing.is_noise).toBe(1);

    const news = db.prepare("SELECT is_noise FROM messages WHERE message_id = ?").get("<news@example.com>") as any;
    expect(news.is_noise).toBe(1);

    const respond = db.prepare("SELECT is_noise FROM messages WHERE message_id = ?").get("<respond@example.com>") as any;
    expect(respond.is_noise).toBe(0);
  });
});
