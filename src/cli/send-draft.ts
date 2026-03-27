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
  loadForwardSourceExcerpt,
  composeForwardDraftBody,
  rewriteDraftWithInstruction,
  type DraftFrontmatter,
  type DraftRecord,
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

/** Human-readable draft for `zmail draft view --text`. */
export function formatDraftViewText(d: DraftRecord): string {
  const fm = d.frontmatter;
  const lines: string[] = [];
  lines.push(`Draft-ID: ${d.id}`);
  lines.push(`Kind: ${fm.kind}`);
  if (fm.to?.length) lines.push(`To: ${fm.to.join(", ")}`);
  if (fm.cc?.length) lines.push(`Cc: ${fm.cc.join(", ")}`);
  if (fm.bcc?.length) lines.push(`Bcc: ${fm.bcc.join(", ")}`);
  if (fm.subject != null && fm.subject !== "") lines.push(`Subject: ${fm.subject}`);
  if (fm.threadId) lines.push(`Thread-ID: ${fm.threadId}`);
  if (fm.sourceMessageId) lines.push(`Source-Message-ID: ${fm.sourceMessageId}`);
  if (fm.forwardOf) lines.push(`Forward-Of: ${fm.forwardOf}`);
  if (fm.inReplyTo) lines.push(`In-Reply-To: ${fm.inReplyTo}`);
  if (fm.references) lines.push(`References: ${fm.references}`);
  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push(d.body);
  return lines.join("\n");
}

/**
 * After create/update, print full draft as JSON (default) or human-readable text via {@link formatDraftViewText}.
 */
export function printDraftRecordOutput(d: DraftRecord, asJson: boolean): void {
  if (asJson) {
    console.log(JSON.stringify({ id: d.id, ...d.frontmatter, body: d.body }, null, 2));
  } else {
    console.log(formatDraftViewText(d));
  }
}

/** Positional args for `draft edit` (only `--text` allowed besides id + instruction words). */
export function draftEditPositionals(rest: string[]): string[] {
  const out: string[] = [];
  for (const a of rest) {
    if (a === "--text") continue;
    if (a.startsWith("--")) {
      throw new Error(`draft edit: unknown flag ${a}`);
    }
    out.push(a);
  }
  return out;
}

/** Positional args for `draft rewrite` after skipping --text and --subject/--to/--body-file (+ values). */
export function draftRewritePositionals(rest: string[]): string[] {
  const valueFlags = new Set(["--subject", "--to", "--body-file"]);
  const out: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--text") continue;
    if (valueFlags.has(a)) {
      i++;
      continue;
    }
    if (a.startsWith("--subject=") || a.startsWith("--to=") || a.startsWith("--body-file=")) {
      continue;
    }
    if (a.startsWith("--")) {
      throw new Error(`draft rewrite: unknown flag ${a}`);
    }
    out.push(a);
  }
  return out;
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
  console.error("  zmail draft new --to <addrs> --subject <s> [--body <t> | --body-file <path>] [--text]");
  console.error("  zmail draft reply --message-id <id> [...] [--text]");
  console.error("  zmail draft forward --message-id <id> --to <addrs> [...] [--text]");
  console.error("  zmail draft list [--text]");
  console.error("  zmail draft view <id> [--text]");
  console.error("  zmail draft edit <id> <instruction...> [--text]   (LLM; needs ZMAIL_OPENAI_API_KEY)");
  console.error("  zmail draft rewrite <id> <body...> [--subject <s>] [--to <addrs>] [--body-file <path>] [--text]");
  console.error("");
  console.error("Default output is JSON for structured results; --text prints human-oriented output (full draft text for mutations/view; tab lines for list).");
  console.error("On send, draft bodies are converted from Markdown to plain text for SMTP.");
}

export async function runDraftCli(args: string[]): Promise<void> {
  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    draftUsage();
    process.exit(0);
  }

  requireImapConfig();
  const cfg = loadConfig();
  const sub = args[0];
  const rest = args.slice(1);
  const dataDir = cfg.dataDir;
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
    printDraftRecordOutput(d, asJson);
    return;
  }

  if (sub === "edit") {
    let words: string[];
    try {
      words = draftEditPositionals(rest);
    } catch (e) {
      console.error(e instanceof Error ? e.message : String(e));
      console.error("Usage: zmail draft edit <id> <instruction...>");
      console.error("  Instruction may span multiple words (quote in shell). Pipe stdin for instruction if omitted.");
      process.exit(1);
    }
    if (words.length < 1) {
      console.error("Usage: zmail draft edit <id> <instruction...>");
      process.exit(1);
    }
    const id = words[0]!;
    let instruction = words.slice(1).join(" ").trim();
    if (!instruction && !process.stdin.isTTY) {
      instruction = (await readStdin()).toString("utf8").trim();
    }
    if (!instruction) {
      console.error("zmail draft edit: instruction required (arguments after id, or pipe stdin).");
      process.exit(1);
    }
    const d = readDraft(dataDir, id);
    let apiKey: string;
    try {
      apiKey = cfg.openai.apiKey;
    } catch {
      console.error("zmail draft edit requires ZMAIL_OPENAI_API_KEY or OPENAI_API_KEY.");
      process.exit(1);
    }
    let revised;
    try {
      revised = await rewriteDraftWithInstruction({ draft: d, instruction, apiKey });
    } catch (e) {
      console.error(e instanceof Error ? e.message : String(e));
      process.exit(1);
    }
    const fm = { ...d.frontmatter };
    if (revised.subject !== undefined) fm.subject = revised.subject;
    writeDraft(dataDir, id, fm, revised.body);
    const updated = readDraft(dataDir, id);
    printDraftRecordOutput(updated, asJson);
    return;
  }

  if (sub === "rewrite") {
    let words: string[];
    try {
      words = draftRewritePositionals(rest);
    } catch (e) {
      console.error(e instanceof Error ? e.message : String(e));
      console.error("Usage: zmail draft rewrite <id> <body...> [--subject <s>] [--to <addrs>] [--body-file <path>]");
      process.exit(1);
    }
    if (words.length < 1) {
      console.error("Usage: zmail draft rewrite <id> <body...>");
      process.exit(1);
    }
    const id = words[0]!;
    const d = readDraft(dataDir, id);
    const bodyFile = getFlag(rest, "--body-file");
    const subj = getFlag(rest, "--subject");
    const to = getFlag(rest, "--to");
    let body: string;
    if (bodyFile) {
      body = readFileSync(bodyFile, "utf8");
    } else if (words.length > 1) {
      body = words.slice(1).join(" ").trimEnd();
    } else if (!process.stdin.isTTY) {
      body = (await readStdin()).toString("utf8");
    } else {
      console.error("zmail draft rewrite: body required (words after id, --body-file, or pipe stdin).");
      process.exit(1);
    }
    const fm = { ...d.frontmatter };
    if (subj !== undefined) fm.subject = subj;
    if (to !== undefined) fm.to = splitAddrs(to);
    writeDraft(dataDir, id, fm, body);
    const updated = readDraft(dataDir, id);
    printDraftRecordOutput(updated, asJson);
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
    printDraftRecordOutput(d, asJson);
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
    printDraftRecordOutput(d, asJson);
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
    let preamble = getFlag(rest, "--body");
    const bodyFile = getFlag(rest, "--body-file");
    if (bodyFile) preamble = readFileSync(bodyFile, "utf8");
    if (preamble === undefined && !process.stdin.isTTY) {
      preamble = (await readStdin()).toString("utf8");
    }
    preamble = preamble ?? "";
    const excerpt = await loadForwardSourceExcerpt(db, cfg.maildirPath, row.message_id);
    const body = composeForwardDraftBody(preamble, excerpt);
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
    printDraftRecordOutput(d, asJson);
    return;
  }

  console.error(`Unknown draft subcommand: ${sub}`);
  draftUsage();
  process.exit(1);
}
