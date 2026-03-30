import type { SqliteDatabase } from "~/db";
import { clusterIdentities } from "./cluster";
import { extractSignatureData } from "./signature";

/**
 * Rebuild the people table from messages.
 *
 * Note: `clusterIdentities` still uses address-centric sent/received/mentioned stats.
 * Dynamic `who` (owner-centric OPP-012) may disagree until this path is aligned.
 */
export async function rebuildPeople(db: SqliteDatabase): Promise<void> {
  await db.exec("DELETE FROM people");

  const clusters = await clusterIdentities(db);

  for (const [, cluster] of clusters.entries()) {
    let primaryAddress = cluster.addresses[0];
    let maxUsage = 0;
    for (const identity of cluster.identities) {
      const usage = identity.sentCount + identity.receivedCount;
      if (usage > maxUsage) {
        maxUsage = usage;
        primaryAddress = identity.address;
      }
    }

    const displayNameArray = Array.from(cluster.displayNames);
    const canonicalName = displayNameArray.length > 0 ? displayNameArray[0] : null;
    const aka = displayNameArray.filter((name) => name !== canonicalName);

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

    let phone: string | null = null;
    let title: string | null = null;
    let company: string | null = null;
    const urls: string[] = [];
    const altEmails: string[] = [];

    for (const address of cluster.addresses) {
      const recentMessage = (await (
        await db.prepare(
          /* sql */ `
        SELECT body_text, date
        FROM messages
        WHERE LOWER(from_address) = ?
        ORDER BY date DESC
        LIMIT 1
      `
        )
      ).get(address.toLowerCase())) as { body_text: string; date: string } | null;

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

    await (
      await db.prepare(
        /* sql */ `
      INSERT INTO people (
        canonical_name, aka, primary_address, addresses,
        phone, title, company, urls,
        sent_count, received_count, mentioned_count,
        last_contact, is_noreply, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `
      )
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
      cluster.isNoreply ? 1 : 0
    );
  }
}
