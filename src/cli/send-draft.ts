import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { loadConfig, requireImapConfig } from "~/lib/config";
import { getDb } from "~/db";
import {
  sendSimpleMessage,
  sendRawRfc822,
  sendDraftById,
  writeDraft,
  readDraft,
  listDrafts,
  createDraftId,
  archiveDraftToSent,
  normalizeMessageId,
  type DraftFrontmatter,
} from "~/send";
import { DEV_SEND_ALLOWLIST } from "~/send/recipients";

function getFlag(args: string[], flag: string): string | undefined {
  const eq = `${flag}=`;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === flag && i + 1 < args.length) return args[i + 1];
    if (args[i].startsWith(eq)) return args[i].slice(eq.length);
  }
  return undefined;
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

export function sendUsage(): void {
  console.error("Usage:");
  console.error("  zmail send --to <addr> --subject <s> [--body <text>]   (body optional; stdin if omitted and piped)");
  console.error("  zmail send --raw [--file <path>]                      (RFC 822 from stdin or file)");
  console.error("  zmail send <draft-id>                                 (send a saved draft)");
  console.error("");
  console.error("Flags: --cc --bcc --dry-run --text --json (default JSON for machine output)");
  console.error(`Dev/test: only ${DEV_SEND_ALLOWLIST} unless ZMAIL_SEND_PRODUCTION=1`);
}

export async function runSendCli(args: string[]): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    sendUsage();
    process.exit(0);
  }

  requireImapConfig();
  const dryRun = hasFlag(args, "--dry-run");
  const forceText = hasFlag(args, "--text");
  const useJson = !forceText;

  const positional = args.filter((a) => !a.startsWith("-"));
  const rawMode = hasFlag(args, "--raw");
  const rawFile = getFlag(args, "--file");

  if (rawMode) {
    let buf: Buffer;
    if (rawFile) {
      buf = readFileSync(rawFile);
    } else {
      buf = await readStdin();
    }
    const result = await sendRawRfc822(buf, { dryRun });
    printSendResult(result, useJson);
    return;
  }

  const to = getFlag(args, "--to");
  const subject = getFlag(args, "--subject");
  let body = getFlag(args, "--body");
  const cc = getFlag(args, "--cc");
  const bcc = getFlag(args, "--bcc");

  if (to && subject !== undefined) {
    if (body === undefined && !process.stdin.isTTY) {
      body = (await readStdin()).toString("utf8");
    }
    if (body === undefined) {
      body = "";
    }
    const result = await sendSimpleMessage(
      {
        to: splitAddrs(to),
        cc: cc ? splitAddrs(cc) : undefined,
        bcc: bcc ? splitAddrs(bcc) : undefined,
        subject,
        text: body,
      },
      { dryRun }
    );
    printSendResult(result, useJson);
    return;
  }

  if (positional.length === 1 && !to && !rawMode) {
    const draftId = positional[0];
    const dataDir = loadConfig().dataDir;
    const draftPath = join(dataDir, "drafts", `${draftId}.md`);
    if (existsSync(draftPath)) {
      const db = await getDb();
      const result = await sendDraftById(draftId, {
        dryRun,
        db,
        dataDir,
        maildirPath: loadConfig().maildirPath,
      });
      if (!dryRun && result.ok) {
        archiveDraftToSent(dataDir, draftId);
      }
      printSendResult(result, useJson);
      return;
    }
  }

  console.error("Invalid send arguments.");
  sendUsage();
  process.exit(1);
}

function splitAddrs(s: string): string[] {
  return s
    .split(/[,;]/)
    .map((x) => x.trim())
    .filter(Boolean);
}

async function readStdin(): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function printSendResult(result: Awaited<ReturnType<typeof sendSimpleMessage>>, asJson: boolean): void {
  if (asJson) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`ok=${result.ok} messageId=${result.messageId}${result.dryRun ? " dryRun=true" : ""}`);
    if (result.smtpResponse) console.log(result.smtpResponse);
  }
}

export function draftUsage(): void {
  console.error("Usage:");
  console.error("  zmail draft new --to <addrs> --subject <s> [--body <t> | --body-file <path>]");
  console.error("  zmail draft reply --message-id <id> [--to <addrs>] [--subject <s>] [--body <t>]");
  console.error("  zmail draft forward --message-id <id> --to <addrs> [--subject <s>] [--body <t>]");
  console.error("  zmail draft list");
  console.error("  zmail draft view <id>");
  console.error("  zmail draft edit <id> [--body <t> | --body-file <path>] [--subject <s>] [--to <addrs>]");
  console.error("");
  console.error("Mutating commands print JSON by default (--text for human output).");
}

export async function runDraftCli(args: string[]): Promise<void> {
  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    draftUsage();
    process.exit(0);
  }

  requireImapConfig();
  const sub = args[0];
  const rest = args.slice(1);
  const dataDir = loadConfig().dataDir;
  const forceText = hasFlag(rest, "--text");
  const asJson = !forceText;

  if (sub === "list") {
    const rows = listDrafts(dataDir);
    if (asJson) {
      console.log(JSON.stringify({ drafts: rows }, null, 2));
    } else {
      for (const r of rows) {
        console.log(`${r.id}\t${r.kind}\t${r.subject ?? ""}`);
      }
    }
    return;
  }

  if (sub === "view") {
    const id = rest.find((a) => !a.startsWith("-"));
    if (!id) {
      console.error("Usage: zmail draft view <id>");
      process.exit(1);
    }
    const d = readDraft(dataDir, id);
    if (asJson) {
      console.log(JSON.stringify({ id: d.id, ...d.frontmatter, body: d.body }, null, 2));
    } else {
      console.log(JSON.stringify({ id: d.id, ...d.frontmatter, body: d.body }, null, 2));
    }
    return;
  }

  if (sub === "edit") {
    const id = rest.find((a) => !a.startsWith("-"));
    if (!id) {
      console.error("Usage: zmail draft edit <id> [--body ...] [--body-file ...]");
      process.exit(1);
    }
    const d = readDraft(dataDir, id);
    const bodyFile = getFlag(rest, "--body-file");
    const bodyFlag = getFlag(rest, "--body");
    const subj = getFlag(rest, "--subject");
    const to = getFlag(rest, "--to");
    let body = d.body;
    if (bodyFile) body = readFileSync(bodyFile, "utf8");
    else if (bodyFlag !== undefined) body = bodyFlag;
    const fm = { ...d.frontmatter };
    if (subj !== undefined) fm.subject = subj;
    if (to !== undefined) fm.to = splitAddrs(to);
    writeDraft(dataDir, id, fm, body);
    const updated = readDraft(dataDir, id);
    if (asJson) {
      console.log(JSON.stringify({ id: updated.id, ...updated.frontmatter, body: updated.body }, null, 2));
    } else {
      console.log("Updated draft", id);
    }
    return;
  }

  if (sub === "new") {
    const to = getFlag(rest, "--to");
    const subject = getFlag(rest, "--subject");
    if (!to || subject === undefined) {
      console.error("zmail draft new requires --to and --subject");
      process.exit(1);
    }
    let body = getFlag(rest, "--body");
    const bodyFile = getFlag(rest, "--body-file");
    if (bodyFile) body = readFileSync(bodyFile, "utf8");
    if (body === undefined && !process.stdin.isTTY) {
      body = (await readStdin()).toString("utf8");
    }
    body = body ?? "";
    const id = createDraftId();
    const fm: DraftFrontmatter = { kind: "new", to: splitAddrs(to), subject };
    writeDraft(dataDir, id, fm, body);
    const d = readDraft(dataDir, id);
    if (asJson) {
      console.log(JSON.stringify({ id: d.id, ...d.frontmatter, body: d.body }, null, 2));
    } else {
      console.log(id);
    }
    return;
  }

  if (sub === "reply") {
    const mid = getFlag(rest, "--message-id");
    if (!mid) {
      console.error("zmail draft reply requires --message-id");
      process.exit(1);
    }
    const db = await getDb();
    const row = (await (
      await db.prepare(
        "SELECT message_id, from_address, subject, thread_id FROM messages WHERE message_id = ?"
      )
    ).get(normalizeMessageId(mid))) as
      | {
          message_id: string;
          from_address: string;
          subject: string;
          thread_id: string;
        }
      | undefined;
    if (!row) {
      console.error(`Message not found: ${mid}`);
      process.exit(1);
    }
    let to = getFlag(rest, "--to");
    const toList = to ? splitAddrs(to) : [row.from_address];
    let subject = getFlag(rest, "--subject") ?? (row.subject.startsWith("Re:") ? row.subject : `Re: ${row.subject}`);
    let body = getFlag(rest, "--body");
    const bodyFile = getFlag(rest, "--body-file");
    if (bodyFile) body = readFileSync(bodyFile, "utf8");
    if (body === undefined && !process.stdin.isTTY) {
      body = (await readStdin()).toString("utf8");
    }
    body = body ?? "";
    const id = createDraftId();
    const fm: DraftFrontmatter = {
      kind: "reply",
      to: toList,
      subject,
      sourceMessageId: row.message_id,
      threadId: row.thread_id,
    };
    writeDraft(dataDir, id, fm, body);
    const d = readDraft(dataDir, id);
    if (asJson) {
      console.log(JSON.stringify({ id: d.id, ...d.frontmatter, body: d.body }, null, 2));
    } else {
      console.log(id);
    }
    return;
  }

  if (sub === "forward") {
    const mid = getFlag(rest, "--message-id");
    const to = getFlag(rest, "--to");
    if (!mid || !to) {
      console.error("zmail draft forward requires --message-id and --to");
      process.exit(1);
    }
    const db = await getDb();
    const row = (await (
      await db.prepare("SELECT message_id, subject, thread_id FROM messages WHERE message_id = ?")
    ).get(normalizeMessageId(mid))) as
      | { message_id: string; subject: string; thread_id: string }
      | undefined;
    if (!row) {
      console.error(`Message not found: ${mid}`);
      process.exit(1);
    }
    let subject = getFlag(rest, "--subject") ?? `Fwd: ${row.subject}`;
    let body = getFlag(rest, "--body");
    const bodyFile = getFlag(rest, "--body-file");
    if (bodyFile) body = readFileSync(bodyFile, "utf8");
    if (body === undefined && !process.stdin.isTTY) {
      body = (await readStdin()).toString("utf8");
    }
    body = body ?? "\n\n--- forwarded message ---\n(original body not inlined; use zmail read)\n";
    const id = createDraftId();
    const fm: DraftFrontmatter = {
      kind: "forward",
      to: splitAddrs(to),
      subject,
      forwardOf: row.message_id,
      threadId: row.thread_id,
    };
    writeDraft(dataDir, id, fm, body);
    const d = readDraft(dataDir, id);
    if (asJson) {
      console.log(JSON.stringify({ id: d.id, ...d.frontmatter, body: d.body }, null, 2));
    } else {
      console.log(id);
    }
    return;
  }

  console.error(`Unknown draft subcommand: ${sub}`);
  draftUsage();
  process.exit(1);
}
