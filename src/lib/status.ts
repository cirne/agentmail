/**
 * Shared status logic for CLI and MCP interfaces.
 * Provides structured status data from the database.
 */

import type { SqliteDatabase } from "~/db";
import { getDb } from "~/db";
import { config, requireImapConfig } from "~/lib/config";
import { logger } from "~/lib/logger";
import { ImapFlow } from "imapflow";

export interface TimeAgo {
  human: string;
  duration: string; // ISO 8601 duration (P1DT2H30M)
}

/**
 * Format time since a given ISO date as human-readable + ISO 8601 duration.
 * Returns null if no valid date.
 */
export function formatTimeAgo(isoDate: string | null): TimeAgo | null {
  if (!isoDate) return null;
  const date = isoDate.includes("Z") || isoDate.includes("+")
    ? new Date(isoDate)
    : new Date(isoDate.replace(" ", "T") + "Z");
  const ms = Date.now() - date.getTime();
  if (ms < 0) return null; // future date
  const sec = Math.floor(ms / 1000);
  const min = Math.floor(sec / 60);
  const hr = Math.floor(min / 60);
  const day = Math.floor(hr / 24);
  const week = Math.floor(day / 7);
  const month = Math.floor(day / 30);
  const year = Math.floor(day / 365);

  let human: string;
  let duration: string;
  if (sec < 60) {
    human = "just now";
    duration = "PT0S";
  } else if (min < 60) {
    human = `${min} ${min === 1 ? "minute" : "minutes"} ago`;
    duration = `PT${min}M`;
  } else if (hr < 24) {
    human = `${hr} ${hr === 1 ? "hour" : "hours"} ago`;
    duration = `PT${hr}H`;
  } else if (day < 7) {
    human = `${day} ${day === 1 ? "day" : "days"} ago`;
    duration = `P${day}D`;
  } else if (week < 4) {
    human = `${week} ${week === 1 ? "week" : "weeks"} ago`;
    duration = `P${week}W`;
  } else if (month < 12) {
    human = `${month} ${month === 1 ? "month" : "months"} ago`;
    duration = `P${month * 30}D`; // approximate
  } else {
    human = `${year} ${year === 1 ? "year" : "years"} ago`;
    duration = `P${year}Y`;
  }
  return { human, duration };
}

export interface StatusData {
  sync: {
    isRunning: boolean;
    lastSyncAt: string | null;
    totalMessages: number;
    earliestSyncedDate: string | null;
    latestSyncedDate: string | null;
    targetStartDate: string | null;
    syncStartEarliestDate: string | null;
  };
  search: {
    ftsReady: number;
  };
  dateRange: {
    earliest: string;
    latest: string;
  } | null;
}

export interface ImapServerComparison {
  server: {
    messages: number;
    uidNext: number | undefined;
    uidValidity: number | undefined;
  };
  local: {
    messages: number;
    lastUid: number | undefined;
    uidValidity: number | undefined;
  };
  missing: number | null;
  missingUidRange: { start: number; end: number } | null;
  uidValidityMismatch: boolean;
  coverage: {
    daysAgo: number;
    yearsAgo: string;
    earliestDate: string;
  } | null;
}

/**
 * Get current sync and search status from the database.
 */
export async function getStatus(db?: SqliteDatabase): Promise<StatusData> {
  const d = db ?? (await getDb());
  const syncStatus = (await (await d.prepare("SELECT * FROM sync_summary WHERE id = 1")).get()) as {
    earliest_synced_date: string | null;
    latest_synced_date: string | null;
    target_start_date: string | null;
    sync_start_earliest_date: string | null;
    total_messages: number;
    last_sync_at: string | null;
    is_running: number;
  } | undefined;

  const messagesCount = (await (await d.prepare("SELECT COUNT(*) as count FROM messages")).get()) as { count: number };

  const dateRange = (await (await d.prepare("SELECT MIN(date) as earliest, MAX(date) as latest FROM messages")).get()) as {
    earliest: string | null;
    latest: string | null;
  };

  const sync = syncStatus
    ? {
        isRunning: syncStatus.is_running === 1,
        lastSyncAt: syncStatus.last_sync_at,
        totalMessages: syncStatus.total_messages,
        earliestSyncedDate: syncStatus.earliest_synced_date,
        latestSyncedDate: syncStatus.latest_synced_date,
        targetStartDate: syncStatus.target_start_date ?? null,
        syncStartEarliestDate: syncStatus.sync_start_earliest_date ?? null,
      }
    : {
        isRunning: false,
        lastSyncAt: null,
        totalMessages: 0,
        earliestSyncedDate: null,
        latestSyncedDate: null,
        targetStartDate: null,
        syncStartEarliestDate: null,
      };

  const search = {
    ftsReady: messagesCount.count,
  };

  return {
    sync,
    search,
    dateRange: dateRange?.earliest && dateRange?.latest
      ? {
          earliest: dateRange.earliest,
          latest: dateRange.latest,
        }
      : null,
  };
}

/**
 * Get IMAP server comparison status (optional, requires IMAP connection).
 */
export async function getImapServerStatus(db?: SqliteDatabase): Promise<ImapServerComparison | null> {
  try {
    const imap = requireImapConfig();
    if (!imap.user || !imap.password) {
      return null;
    }

    const mailbox = config.sync.mailbox || (imap.host.toLowerCase().includes("gmail") ? "[Gmail]/All Mail" : "INBOX");

    const client = new ImapFlow({
      host: imap.host,
      port: imap.port,
      secure: imap.port === 993,
      auth: { user: imap.user, pass: imap.password },
      logger: false,
    });

    try {
      await client.connect();

      const statusResult = await client.status(mailbox, { messages: true, uidNext: true, uidValidity: true });
      const serverMessages = statusResult.messages ?? 0;
      const serverUidNext = statusResult.uidNext ? Number(statusResult.uidNext) : undefined;
      const serverUidValidity = statusResult.uidValidity ? Number(statusResult.uidValidity) : undefined;

      const d = db ?? (await getDb());
      const syncState = (await (await d.prepare("SELECT uidvalidity, last_uid FROM sync_state WHERE folder = ?")).get(
        mailbox
      )) as { uidvalidity: number | bigint; last_uid: number | bigint } | undefined;

      const status = await getStatus(d);
      const localMessages = status.search.ftsReady;
      const localLastUid = syncState ? Number(syncState.last_uid) : undefined;
      const localUidValidity = syncState ? Number(syncState.uidvalidity) : undefined;

      let missing: number | null = null;
      let missingUidRange: { start: number; end: number } | null = null;
      const uidValidityMismatch =
        serverUidValidity !== undefined && localUidValidity !== undefined && serverUidValidity !== localUidValidity;

      if (serverUidNext && localLastUid && !uidValidityMismatch) {
        missing = serverUidNext - localLastUid - 1;
        if (missing > 0) {
          missingUidRange = {
            start: localLastUid + 1,
            end: serverUidNext - 1,
          };
        }
      }

      let coverage: { daysAgo: number; yearsAgo: string; earliestDate: string } | null = null;
      if (status.dateRange?.earliest) {
        const earliestDate = new Date(status.dateRange.earliest);
        const now = new Date();
        const daysAgo = Math.floor((now.getTime() - earliestDate.getTime()) / (1000 * 60 * 60 * 24));
        const yearsAgo = (daysAgo / 365).toFixed(1);
        coverage = {
          daysAgo,
          yearsAgo,
          earliestDate: status.dateRange.earliest.slice(0, 10),
        };
      }

      client.close();

      return {
        server: {
          messages: serverMessages,
          uidNext: serverUidNext,
          uidValidity: serverUidValidity,
        },
        local: {
          messages: localMessages,
          lastUid: localLastUid,
          uidValidity: localUidValidity,
        },
        missing,
        missingUidRange,
        uidValidityMismatch,
        coverage,
      };
    } catch (err) {
      logger.warn("Failed to check server status", { error: String(err) });
      client.close();
      return null;
    }
  } catch (err) {
    return null;
  }
}
