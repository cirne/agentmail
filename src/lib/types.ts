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

export interface SearchResult {
  messageId: string;
  threadId: string;
  fromAddress: string;
  fromName: string | null;
  subject: string;
  date: string;
  snippet: string;
  rank: number;
}

/** One identity from `zmail who`: merged person with all addresses, contact info, and counts. */
export interface WhoPerson {
  /** First name (if parseable as person name) */
  firstname?: string | null;
  /** Last name (if parseable as person name) */
  lastname?: string | null;
  /** Full name (used when name can't be parsed into firstname/lastname, e.g., "Apple, Inc.") */
  name?: string | null;
  aka: string[];
  primaryAddress: string;
  addresses: string[];
  phone: string | null;
  title: string | null;
  company: string | null;
  urls: string[];
  sentCount: number;
  receivedCount: number;
  mentionedCount: number;
  lastContact: string | null;
}

/** Result of who(db, { query, ... }). */
export interface WhoResult {
  query: string;
  people: WhoPerson[];
  /** Optional hint to suggest improvements (e.g., using --enrich flag) */
  hint?: string;
}
