// Core domain types shared across modules

export interface Message {
  id: number;
  messageId: string; // RFC 2822 Message-ID header
  threadId: string;
  folder: string;
  uid: number;
  fromAddress: string;
  fromName: string | null;
  toAddresses: string; // JSON array
  ccAddresses: string; // JSON array
  subject: string;
  date: string; // ISO 8601
  bodyText: string;
  rawPath: string; // path to .eml file in maildir
  syncedAt: string;
}

export interface Thread {
  threadId: string;
  subject: string;
  participantCount: number;
  messageCount: number;
  lastMessageAt: string;
}

export interface Attachment {
  id: number;
  messageId: string;
  filename: string;
  mimeType: string;
  size: number;
  storedPath: string;
  extractedText: string | null;
}

export interface Contact {
  address: string;
  displayName: string | null;
  messageCount: number;
}

export interface SyncState {
  folder: string;
  uidvalidity: number;
  lastUid: number;
}

export interface SyncWindow {
  id: number;
  phase: number;
  windowStart: string;
  windowEnd: string;
  status: "pending" | "running" | "completed" | "failed";
  messagesFound: number;
  messagesSynced: number;
  startedAt: string | null;
  completedAt: string | null;
}

export interface SyncSummary {
  earliestSyncedDate: string | null;
  latestSyncedDate: string | null;
  totalMessages: number;
  lastSyncAt: string | null;
  isRunning: boolean;
}

/** Attachment metadata included inline in search results to avoid list_attachments calls. */
export interface SearchResultAttachment {
  id: number;
  filename: string;
  mimeType: string;
  size: number;
  /** True when extracted text is cached in the DB (read is faster). */
  extracted: boolean;
  index: number; // 1-based for CLI/MCP read_attachment
}

export interface SearchResult {
  messageId: string;
  threadId: string;
  fromAddress: string;
  fromName: string | null;
  subject: string;
  date: string;
  snippet: string;
  rank: number;
  /**
   * When owner-centric search ranking is active: participant contact-rank term subtracted from
   * combined FTS+date rank (same units as `rank`). OPP-012. Set when `DEBUG_SEARCH=1`.
   */
  contactRankBoost?: number;
  /** First ~300 chars of body (always present) to reduce follow-up get_message calls. */
  bodyPreview?: string;
  /** Inline attachment metadata when requested to avoid list_attachments round-trips. */
  attachments?: SearchResultAttachment[];
}

/** One identity from `zmail who`: merged person with all addresses, contact info, and counts. */
export interface WhoPerson {
  /** First name (if parseable as person name) */
  firstname?: string;
  /** Last name (if parseable as person name) */
  lastname?: string;
  /** Full name (used when name can't be parsed into firstname/lastname, e.g., "Apple, Inc.") */
  name?: string;
  /** Other display names for the same identity (omitted when empty in JSON). */
  aka?: string[];
  primaryAddress: string;
  addresses: string[];
  phone?: string;
  title?: string;
  company?: string;
  urls?: string[];
  sentCount: number;
  /** Owner→peer replies in existing threads (not the first outbound in that thread). OPP-012. */
  repliedCount: number;
  receivedCount: number;
  /** CC-only exposure: peer in cc, not the sender (OPP-012). */
  mentionedCount: number;
  /** Mailbox interaction rank from indexed mail (shared with search ordering). Higher = stronger signal, not personal worth. */
  contactRank: number;
  /** ISO 8601 timestamp of most recent message involving this identity */
  lastContact?: string;
}

/** Result of who(db, { query, ... }). */
export interface WhoResult {
  query: string;
  people: WhoPerson[];
  /** Optional hint to suggest improvements (e.g., using --enrich flag) */
  hint?: string;
}
