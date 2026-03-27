import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, renameSync } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

export type DraftKind = "new" | "reply" | "forward";

export interface DraftFrontmatter {
  kind: DraftKind;
  to?: string[];
  cc?: string[];
  bcc?: string[];
  subject?: string;
  inReplyTo?: string;
  references?: string;
  threadId?: string;
  sourceMessageId?: string;
  forwardOf?: string;
}

export interface DraftRecord {
  id: string;
  frontmatter: DraftFrontmatter;
  body: string;
  path: string;
}

const FRONTMATTER_DELIM = "---";

export function draftsDir(dataDir: string): string {
  return join(dataDir, "drafts");
}

export function sentDir(dataDir: string): string {
  return join(dataDir, "sent");
}

function parseDraftMarkdown(content: string): { frontmatter: DraftFrontmatter; body: string } {
  const lines = content.split(/\r?\n/);
  if (lines[0]?.trim() !== FRONTMATTER_DELIM) {
    throw new Error("Draft must start with YAML frontmatter (---)");
  }
  let i = 1;
  const yamlLines: string[] = [];
  while (i < lines.length && lines[i] !== FRONTMATTER_DELIM) {
    yamlLines.push(lines[i]);
    i++;
  }
  if (i >= lines.length || lines[i] !== FRONTMATTER_DELIM) {
    throw new Error("Draft frontmatter missing closing ---");
  }
  const yamlBlock = yamlLines.join("\n").trim();
  i += 1;
  const body = lines.slice(i).join("\n").replace(/^\n/, "") || "";
  const data = parseYaml(yamlBlock) as Record<string, unknown>;
  const kind = (data.kind as DraftKind) || "new";
  const to = data.to as string[] | string | undefined;
  const cc = data.cc as string[] | string | undefined;
  const bcc = data.bcc as string[] | string | undefined;
  const normList = (v: string[] | string | undefined): string[] | undefined => {
    if (v == null) return undefined;
    if (Array.isArray(v)) return v;
    if (typeof v === "string") return [v];
    return undefined;
  };
  const frontmatter: DraftFrontmatter = {
    kind,
    to: normList(to),
    cc: normList(cc),
    bcc: normList(bcc),
    subject: data.subject as string | undefined,
    inReplyTo: data.inReplyTo as string | undefined,
    references: data.references as string | undefined,
    threadId: data.threadId as string | undefined,
    sourceMessageId: data.sourceMessageId as string | undefined,
    forwardOf: data.forwardOf as string | undefined,
  };
  return { frontmatter, body };
}

export function serializeDraftMarkdown(frontmatter: DraftFrontmatter, body: string): string {
  const yaml = stringifyYaml(frontmatter, { lineWidth: 0 }).trimEnd();
  return `${FRONTMATTER_DELIM}\n${yaml}\n${FRONTMATTER_DELIM}\n\n${body}`;
}

export function readDraft(dataDir: string, id: string): DraftRecord {
  const path = join(draftsDir(dataDir), `${id}.md`);
  if (!existsSync(path)) {
    throw new Error(`Draft not found: ${id}`);
  }
  const content = readFileSync(path, "utf8");
  const { frontmatter, body } = parseDraftMarkdown(content);
  return { id, frontmatter, body, path };
}

export function writeDraft(dataDir: string, id: string, frontmatter: DraftFrontmatter, body: string): string {
  const dir = draftsDir(dataDir);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${id}.md`);
  writeFileSync(path, serializeDraftMarkdown(frontmatter, body), "utf8");
  return path;
}

export function createDraftId(): string {
  return randomUUID();
}

export function listDrafts(dataDir: string): Array<{ id: string; subject?: string; kind: DraftKind }> {
  const dir = draftsDir(dataDir);
  if (!existsSync(dir)) return [];
  const out: Array<{ id: string; subject?: string; kind: DraftKind }> = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".md")) continue;
    const id = name.replace(/\.md$/, "");
    try {
      const d = readDraft(dataDir, id);
      out.push({
        id,
        subject: d.frontmatter.subject,
        kind: d.frontmatter.kind,
      });
    } catch {
      // skip invalid
    }
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

export function archiveDraftToSent(dataDir: string, draftId: string): string {
  const src = join(draftsDir(dataDir), `${draftId}.md`);
  const sent = sentDir(dataDir);
  mkdirSync(sent, { recursive: true });
  const dest = join(sent, `${draftId}-sent.md`);
  renameSync(src, dest);
  return dest;
}
