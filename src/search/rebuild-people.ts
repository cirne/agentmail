import type { SqliteDatabase } from "~/db";
import { clusterIdentities } from "./cluster";
import { extractSignatureData } from "./signature";

/**
 * Rebuild the people table from messages.
 * Clusters identities, extracts signatures, and upserts into people table.
 */
export function rebuildPeople(db: SqliteDatabase): void {
  // Clear existing people table
  db.exec("DELETE FROM people");

  // Cluster identities
  const clusters = clusterIdentities(db);

  // For each cluster, extract signature data and upsert into people table
  for (const [, cluster] of clusters.entries()) {
    // Determine primary address (most used)
    let primaryAddress = cluster.addresses[0];
    let maxUsage = 0;
    for (const identity of cluster.identities) {
      const usage = identity.sentCount + identity.receivedCount;
      if (usage > maxUsage) {
        maxUsage = usage;
        primaryAddress = identity.address;
      }
    }

    // Get canonical name (most common display name, or first one)
    const displayNameArray = Array.from(cluster.displayNames);
    const canonicalName = displayNameArray.length > 0 ? displayNameArray[0] : null;

    // Get all display names for aka field
    const aka = displayNameArray.filter((name) => name !== canonicalName);

    // Aggregate counts
    let totalSent = 0;
    let totalReceived = 0;
    let totalMentioned = 0;
    let lastContact: string | null = null;

    for (const identity of cluster.identities) {
      totalSent += identity.sentCount;
      totalReceived += identity.receivedCount;
      totalMentioned += identity.mentionedCount;
      if (identity.lastContact && (!lastContact || identity.lastContact > lastContact)) {
        lastContact = identity.lastContact;
      }
    }

    // Extract signature data from most recent email per address
    let phone: string | null = null;
    let title: string | null = null;
    let company: string | null = null;
    const urls: string[] = [];
    const altEmails: string[] = [];

    for (const address of cluster.addresses) {
      const recentMessage = db
        .prepare(
          /* sql */ `
        SELECT body_text, date
        FROM messages
        WHERE LOWER(from_address) = ?
        ORDER BY date DESC
        LIMIT 1
      `
        )
        .get(address.toLowerCase()) as { body_text: string; date: string } | null;

      if (recentMessage) {
        const sigData = extractSignatureData(recentMessage.body_text, address);
        if (sigData) {
          if (sigData.phone && !phone) phone = sigData.phone;
          if (sigData.title && !title) title = sigData.title;
          if (sigData.company && !company) company = sigData.company;
          for (const url of sigData.urls) {
            if (!urls.includes(url)) urls.push(url);
          }
          for (const email of sigData.altEmails) {
            if (!altEmails.includes(email)) altEmails.push(email);
          }
        }
      }
    }

    // Upsert into people table
    db.prepare(
      /* sql */ `
      INSERT INTO people (
        canonical_name, aka, primary_address, addresses,
        phone, title, company, urls,
        sent_count, received_count, mentioned_count,
        last_contact, is_noreply, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `
    ).run(
      canonicalName,
      JSON.stringify(aka),
      primaryAddress,
      JSON.stringify(cluster.addresses),
      phone,
      title,
      company,
      JSON.stringify(urls),
      totalSent,
      totalReceived,
      totalMentioned,
      lastContact,
      cluster.isNoreply ? 1 : 0,
    );
  }
}
