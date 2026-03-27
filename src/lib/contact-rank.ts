/**
 * Shared contact rank (OPP-027): same formula for `zmail who` ordering and search participant boost.
 * "Rank" = ordering signal from indexed mail (volume, reciprocity); not personal worth.
 * Uses log scaling and per-dimension caps so one noisy channel does not dominate.
 */

/** Raw owner-centric counts (see OPP-027). */
export interface ContactRankFields {
  sentCount: number;
  repliedCount: number;
  receivedCount: number;
  mentionedCount: number;
}

/** Tunable weights — keep in one place for who + search. */
export const CONTACT_RANK_WEIGHT_SENT = 2.2;
export const CONTACT_RANK_WEIGHT_REPLIED = 1.0;
export const CONTACT_RANK_WEIGHT_RECEIVED = 1.4;
export const CONTACT_RANK_WEIGHT_MENTIONED = 0.35;

/** Cap inside log so a single huge dimension does not dominate. */
export const CONTACT_RANK_LOG_CAP = 48;

/** Scale: participant contact rank reduces combined_rank (FTS+date); keep small so keywords dominate. */
export const SEARCH_CONTACT_RANK_BOOST_ALPHA = 0.12;

/**
 * Dampens the **received** term when inbound volume dominates owner→peer outbound (high
 * effective received:sent — including “divide by zero” when sent+replied is 0). Full
 * `receivedCount` still drives `log1p(received)`; this multiplier is the asymmetry signal.
 *
 * `mult = (outbound + ε) / (outbound + ε + λ * log1p(received))` — smooth, no cap on counts,
 * no literal division by outbound.
 */
export const RECEIVED_ASYMMETRY_LAMBDA = 2.5;

/** Stabilizes the ratio when outbound is 0 (pure inbound) or received is 0. */
export const OUTBOUND_RECEIVED_RATIO_EPSILON = 1;

function cappedLog1p(n: number): number {
  const x = Math.log1p(Math.max(0, n));
  return Math.min(x, CONTACT_RANK_LOG_CAP);
}

function receivedInboundMultiplier(fields: ContactRankFields): number {
  const outbound = Math.max(0, fields.sentCount + fields.repliedCount);
  const inboundLog = cappedLog1p(fields.receivedCount);
  const numer = outbound + OUTBOUND_RECEIVED_RATIO_EPSILON;
  const denom = numer + RECEIVED_ASYMMETRY_LAMBDA * inboundLog;
  if (denom <= 0) return 0;
  return numer / denom;
}

/**
 * Single scalar contact rank for ordering (higher = stronger mailbox interaction signal).
 */
export function computeContactRank(fields: ContactRankFields): number {
  const recvMult = receivedInboundMultiplier(fields);
  return (
    CONTACT_RANK_WEIGHT_SENT * cappedLog1p(fields.sentCount) +
    CONTACT_RANK_WEIGHT_REPLIED * cappedLog1p(fields.repliedCount) +
    CONTACT_RANK_WEIGHT_RECEIVED * recvMult * cappedLog1p(fields.receivedCount) +
    CONTACT_RANK_WEIGHT_MENTIONED * cappedLog1p(fields.mentionedCount)
  );
}

/**
 * Tiered date recency boost matching FTS `dateBoostSql` in search (fractional days since message).
 * Larger = more recent; used as `combinedRank = -dateBoost` when there is no BM25 rank.
 */
export function searchDateRecencyBoostDaysAgo(daysAgo: number): number {
  const d = Math.max(0, daysAgo);
  if (d <= 1) return 10.0;
  if (d <= 7) return 8.0 - d * 0.5;
  if (d <= 30) return 4.5 - (d - 7) * 0.1;
  if (d <= 90) return 1.2 - (d - 30) * 0.01;
  return 0.6 - (d - 90) * 0.001;
}

/** `combinedRank` for filter-only search rows (lower is better), mirroring FTS date term with rank=0. */
export function filterOnlyCombinedRankFromMessageDate(isoDate: string): number {
  const t = new Date(isoDate).getTime();
  if (Number.isNaN(t)) return 0;
  const daysAgo = (Date.now() - t) / 86400000;
  return -searchDateRecencyBoostDaysAgo(daysAgo);
}
