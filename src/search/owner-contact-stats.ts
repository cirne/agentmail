import type { SqliteDatabase } from "~/db";
import type { ContactRankFields } from "~/lib/contact-rank";
import { computeContactRank } from "~/lib/contact-rank";
import { normalizeAddress } from "./normalize";
import { isNoreply } from "./noreply";

export interface OwnerContactStats extends ContactRankFields {
  lastContact: string | null;
}

export function parseJsonAddresses(raw: string): string[] {
  try {
    const v = JSON.parse(raw) as unknown;
    if (!Array.isArray(v)) return [];
    return v.filter((x): x is string => typeof x === "string");
  } catch {
    return [];
  }
}

function ownerSeesMessage(ownerNorm: string, toRaw: string[], ccRaw: string[]): boolean {
  for (const a of toRaw) {
    if (normalizeAddress(a) === ownerNorm) return true;
  }
  for (const a of ccRaw) {
    if (normalizeAddress(a) === ownerNorm) return true;
  }
  return false;
}

function emptyStats(): OwnerContactStats {
  return {
    sentCount: 0,
    repliedCount: 0,
    receivedCount: 0,
    mentionedCount: 0,
    lastContact: null,
  };
}

function bumpLast(s: OwnerContactStats, date: string): void {
  if (!s.lastContact || date > s.lastContact) s.lastContact = date;
}

/**
 * Load messages that may involve any normalized address in `candidateNorms` or the owner.
 * Filters in memory so Gmail-style dot normalization matches DB addresses.
 */
async function loadMessagesForOwnerStats(
  db: SqliteDatabase,
  ownerNorm: string,
  candidateNorms: Set<string>
): Promise<
  Array<{
    thread_id: string;
    date: string;
    from_address: string;
    to_addresses: string;
    cc_addresses: string;
  }>
> {
  const rows = (await (
    await db.prepare(
      /* sql */ `
      SELECT thread_id, date, from_address, to_addresses, cc_addresses
      FROM messages
      ORDER BY date ASC
    `
    )
  ).all()) as Array<{
    thread_id: string;
    date: string;
    from_address: string;
    to_addresses: string;
    cc_addresses: string;
  }>;

  const want = new Set<string>([ownerNorm, ...candidateNorms]);
  return rows.filter((m) => {
    const fromN = normalizeAddress(m.from_address);
    if (want.has(fromN)) return true;
    const to = parseJsonAddresses(m.to_addresses);
    const cc = parseJsonAddresses(m.cc_addresses);
    for (const a of to) {
      if (want.has(normalizeAddress(a))) return true;
    }
    for (const a of cc) {
      if (want.has(normalizeAddress(a))) return true;
    }
    return false;
  });
}

/**
 * Owner-centric counts for each normalized peer address in `candidateNorms`.
 * Skips noreply peers for count increments (OPP-012 / OPP-027).
 */
export async function computeOwnerCentricStatsForCandidates(
  db: SqliteDatabase,
  ownerAddress: string,
  candidateNorms: Iterable<string>
): Promise<Map<string, OwnerContactStats>> {
  const ownerNorm = normalizeAddress(ownerAddress);
  const candidates = new Set<string>();
  for (const a of candidateNorms) {
    const n = normalizeAddress(a);
    if (n !== ownerNorm) candidates.add(n);
  }

  const stats = new Map<string, OwnerContactStats>();
  for (const c of candidates) {
    stats.set(c, emptyStats());
  }

  if (candidates.size === 0) {
    return stats;
  }

  const messages = await loadMessagesForOwnerStats(db, ownerNorm, candidates);

  /** First owner→peer outbound in this thread (by date order) is sent; later are replied. */
  const seenOwnerToPeerInThread = new Set<string>();

  for (const m of messages) {
    const fromN = normalizeAddress(m.from_address);
    const toRaw = parseJsonAddresses(m.to_addresses);
    const ccRaw = parseJsonAddresses(m.cc_addresses);
    const toNorm = toRaw.map((x) => normalizeAddress(x));
    const ccNorm = ccRaw.map((x) => normalizeAddress(x));
    const toSet = new Set(toNorm);
    const ccSet = new Set(ccNorm);

    // received: from peer to owner
    if (candidates.has(fromN) && ownerSeesMessage(ownerNorm, toRaw, ccRaw)) {
      if (!isNoreply(m.from_address)) {
        const s = stats.get(fromN);
        if (s) s.receivedCount += 1;
      }
    }

    // mentioned: peer in CC only, not the sender (CC-only exposure)
    for (const peer of ccNorm) {
      if (peer === ownerNorm) continue;
      if (!candidates.has(peer)) continue;
      if (fromN === peer) continue;
      if (isNoreply(peer)) continue;
      const s = stats.get(peer);
      if (s) s.mentionedCount += 1;
    }

    // owner → peer: sent vs replied
    if (fromN === ownerNorm) {
      const recipients = new Set<string>();
      for (const p of toNorm) {
        if (p !== ownerNorm) recipients.add(p);
      }
      for (const p of ccNorm) {
        if (p !== ownerNorm) recipients.add(p);
      }
      for (const peer of recipients) {
        if (!candidates.has(peer)) continue;
        if (isNoreply(peer)) continue;
        const key = `${m.thread_id}\0${peer}`;
        const s = stats.get(peer);
        if (!s) continue;
        if (!seenOwnerToPeerInThread.has(key)) {
          seenOwnerToPeerInThread.add(key);
          s.sentCount += 1;
        } else {
          s.repliedCount += 1;
        }
      }
    }

    // lastContact: any message involving this candidate as from/to/cc participant
    for (const c of candidates) {
      if (isNoreply(c)) continue;
      const involved = fromN === c || toSet.has(c) || ccSet.has(c);
      if (involved) {
        const s = stats.get(c);
        if (s) bumpLast(s, m.date);
      }
    }
  }

  return stats;
}

/** Contact rank per normalized address (for search / inbox / refresh ordering). */
export async function computeContactRankMapForAddresses(
  db: SqliteDatabase,
  ownerAddress: string,
  addresses: Iterable<string>
): Promise<Map<string, number>> {
  const norms = new Set<string>();
  for (const a of addresses) {
    norms.add(normalizeAddress(a));
  }
  const stats = await computeOwnerCentricStatsForCandidates(db, ownerAddress, norms);
  const out = new Map<string, number>();
  for (const [addr, s] of stats) {
    out.set(addr, computeContactRank(s));
  }
  return out;
}

const DEFAULT_INBOX_PREFETCH_CAP = 200;

/**
 * Sort rows by sender contact rank (desc), then date (desc). No-op if `ownerAddress` is unset.
 * Used for inbox candidates and refresh new-mail preview.
 */
export async function sortRowsBySenderContactRank<T extends { fromAddress: string; date: string }>(
  db: SqliteDatabase,
  ownerAddress: string | undefined,
  rows: T[]
): Promise<T[]> {
  if (!ownerAddress?.trim() || rows.length === 0) {
    return [...rows];
  }
  const norms = [...new Set(rows.map((r) => normalizeAddress(r.fromAddress)))];
  const rankMap = await computeContactRankMapForAddresses(db, ownerAddress, norms);
  return [...rows].sort((a, b) => {
    const ra = rankMap.get(normalizeAddress(a.fromAddress)) ?? 0;
    const rb = rankMap.get(normalizeAddress(b.fromAddress)) ?? 0;
    if (rb !== ra) return rb - ra;
    return b.date.localeCompare(a.date);
  });
}

/** Bounded prefetch size for inbox-style windows: min(candidateCap * 2, ceiling). */
export function inboxCandidatePrefetchLimit(candidateCap: number, ceiling = DEFAULT_INBOX_PREFETCH_CAP): number {
  return Math.min(candidateCap * 2, ceiling);
}
