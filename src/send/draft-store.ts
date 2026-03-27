import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, renameSync } from "fs";
import { join, resolve } from "path";
import { randomBytes } from "crypto";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

/** Max length of the subject-derived slug before `_` and the 8-char unique suffix. */
export const DRAFT_SUBJECT_SLUG_MAX = 40;

const SUFFIX_ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

export type DraftKind = "new" | "reply" | "forward";

export interface DraftFrontmatter {
  /** Filename stem (no `.md`); same as the draft file basename under data/drafts/. */
  id?: string;
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

/** Agent-first JSON: absolute path + headers; omit body unless `withBody`. */
export function draftRecordToJsonObject(d: DraftRecord, withBody: boolean): Record<string, unknown> {
  const base: Record<string, unknown> = { path: resolve(d.path), id: d.id, ...d.frontmatter };
  if (withBody) base.body = d.body;
  return base;
}

const FRONTMATTER_DELIM = "---";

/**
 * Draft CLI/API accepts a filename with or without `.md`; stored files are always `{name}.md`.
 */
export function normalizeDraftFilename(input: string): string {
  const t = input.trim();
  if (t.length >= 4 && t.toLowerCase().endsWith(".md")) {
    return t.slice(0, -3);
  }
  return t;
}

export function draftsDir(dataDir: string): string {
  return join(dataDir, "drafts");
}

/** Peer of {@link draftsDir}: successfully sent drafts are moved here from `drafts/` (same `{stem}.md` name). */
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
    id: typeof data.id === "string" ? data.id : undefined,
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
  const base = normalizeDraftFilename(id);
  const path = resolve(join(draftsDir(dataDir), `${base}.md`));
  if (!existsSync(path)) {
    throw new Error(`Draft not found: ${base}`);
  }
  const content = readFileSync(path, "utf8");
  const { frontmatter, body } = parseDraftMarkdown(content);
  return { id: base, frontmatter: { ...frontmatter, id: base }, body, path };
}

export function writeDraft(dataDir: string, id: string, frontmatter: DraftFrontmatter, body: string): string {
  const base = normalizeDraftFilename(id);
  const dir = draftsDir(dataDir);
  mkdirSync(dir, { recursive: true });
  const path = resolve(join(dir, `${base}.md`));
  const withId: DraftFrontmatter = { ...frontmatter, id: base };
  writeFileSync(path, serializeDraftMarkdown(withId, body), "utf8");
  return path;
}

/**
 * Turn a subject line into a filesystem-safe slug: lowercase [a-z0-9-] only, no underscores.
 */
export function subjectToSlug(subject: string, maxLen: number): string {
  const trimmed = subject.trim();
  const nf = trimmed.normalize("NFKD").replace(/\p{M}/gu, "");
  const ascii = nf
    .split("")
    .map((ch) => {
      const lower = ch.toLowerCase();
      if (/[a-z0-9]/.test(lower)) return lower;
      if (/[\s_/.]/.test(ch)) return "-";
      return "";
    })
    .join("");
  let slug = ascii.replace(/-+/g, "-").replace(/^-|-$/g, "");
  if (slug.length > maxLen) slug = slug.slice(0, maxLen).replace(/-+$/g, "");
  return slug.length > 0 ? slug : "draft";
}

export function generateDraftSuffix8(): string {
  const bytes = randomBytes(8);
  let s = "";
  for (let i = 0; i < 8; i++) {
    s += SUFFIX_ALPHABET[bytes[i]! % SUFFIX_ALPHABET.length];
  }
  return s;
}

/**
 * Allocate a unique draft id (stem, no `.md`): `{slug}_{8 alphanumeric chars}`.
 */
export function createDraftId(dataDir: string, subject: string): string {
  const slug = subjectToSlug(subject, DRAFT_SUBJECT_SLUG_MAX);
  const dir = draftsDir(dataDir);
  mkdirSync(dir, { recursive: true });
  for (let attempt = 0; attempt < 128; attempt++) {
    const id = `${slug}_${generateDraftSuffix8()}`;
    if (!existsSync(join(dir, `${id}.md`))) return id;
  }
  throw new Error("Could not allocate a unique draft id");
}

export function listDrafts(
  dataDir: string
): Array<{ id: string; path: string; subject?: string; kind: DraftKind }> {
  const dir = draftsDir(dataDir);
  if (!existsSync(dir)) return [];
  const out: Array<{ id: string; path: string; subject?: string; kind: DraftKind }> = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".md")) continue;
    const id = name.replace(/\.md$/, "");
    try {
      const d = readDraft(dataDir, id);
      out.push({
        id,
        path: d.path,
        subject: d.frontmatter.subject,
        kind: d.frontmatter.kind,
      });
    } catch {
      // skip invalid
    }
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * After a successful SMTP send, move `drafts/{stem}.md` → `sent/{stem}.md` (peer directory under `dataDir`).
 */
export function archiveDraftToSent(dataDir: string, draftId: string): string {
  const base = normalizeDraftFilename(draftId);
  const src = resolve(join(draftsDir(dataDir), `${base}.md`));
  const sent = sentDir(dataDir);
  mkdirSync(sent, { recursive: true });
  const dest = resolve(join(sent, `${base}.md`));
  renameSync(src, dest);
  return dest;
}
