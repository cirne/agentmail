import type { SqliteDatabase } from "~/db";
import type { WhoPerson, WhoResult } from "~/lib/types";
import { normalizeAddress, normalizedLocalPart } from "./normalize";
import { canonicalFirstName, parseName } from "./nicknames";
import { isNoreply } from "./noreply";
import { extractSignatureData } from "./signature";
import { inferNameFromAddress } from "./infer-name";
import doubleMetaphone from "double-metaphone";
import { distance } from "fastest-levenshtein";

export interface WhoOptions {
  query: string;
  limit?: number;
  minSent?: number;
  minReceived?: number;
  includeNoreply?: boolean;
  ownerAddress?: string;
}

const DEFAULT_LIMIT = 50;

const CONSUMER_DOMAINS = new Set([
  "gmail.com",
  "icloud.com",
  "mac.com",
  "me.com",
  "hotmail.com",
  "outlook.com",
  "live.com",
  "yahoo.com",
  "aol.com",
  "protonmail.com",
  "proton.me",
  "zoho.com",
]);

interface Identity {
  address: string;
  displayName: string | null;
  sentCount: number;
  receivedCount: number;
  mentionedCount: number;
  lastContact: string | null;
}

interface Cluster {
  addresses: string[];
  displayNames: Set<string>;
  identities: Identity[];
  isNoreply: boolean;
}

/**
 * Dynamically build person profiles from messages on-the-fly.
 * No pre-computed index - queries messages directly and clusters in real-time.
 */
export function whoDynamic(db: SqliteDatabase, opts: WhoOptions): WhoResult {
  const {
    query,
    limit = DEFAULT_LIMIT,
    minSent = 0,
    minReceived = 0,
    includeNoreply = false,
  } = opts;

  const queryLower = query.trim().toLowerCase();
  const pattern = `%${queryLower}%`;

  // Step 1: Find matching identities from messages
  const matchingRows = db
    .prepare(
      /* sql */ `
    WITH all_addresses AS (
      SELECT DISTINCT LOWER(from_address) as address, from_name as display_name
      FROM messages
      WHERE LOWER(from_address) LIKE ? OR (from_name IS NOT NULL AND LOWER(from_name) LIKE ?)
      UNION
      SELECT DISTINCT LOWER(j.value) as address, NULL as display_name
      FROM messages m, json_each(m.to_addresses) j
      WHERE LOWER(j.value) LIKE ?
      UNION
      SELECT DISTINCT LOWER(j.value) as address, NULL as display_name
      FROM messages m, json_each(m.cc_addresses) j
      WHERE LOWER(j.value) LIKE ?
    ),
    identities AS (
      SELECT 
        a.address,
        MAX(a.display_name) as display_name,
        (SELECT COUNT(*) FROM messages m WHERE LOWER(m.from_address) = a.address) as sent_count,
        (SELECT COUNT(*) FROM messages m 
         WHERE EXISTS (SELECT 1 FROM json_each(m.to_addresses) WHERE LOWER(value) = a.address)
            OR EXISTS (SELECT 1 FROM json_each(m.cc_addresses) WHERE LOWER(value) = a.address)) as received_count,
        0 as mentioned_count,
        (SELECT MAX(date) FROM messages m 
         WHERE LOWER(m.from_address) = a.address
            OR EXISTS (SELECT 1 FROM json_each(m.to_addresses) WHERE LOWER(value) = a.address)
            OR EXISTS (SELECT 1 FROM json_each(m.cc_addresses) WHERE LOWER(value) = a.address)) as last_contact
      FROM all_addresses a
      GROUP BY a.address
    )
    SELECT * FROM identities
    LIMIT ?
  `
    )
    .all(
      pattern,
      pattern,
      pattern,
      pattern,
      limit * 10 // Fetch more candidates before filtering
    ) as Array<{
    address: string;
    display_name: string | null;
    sent_count: number;
    received_count: number;
    mentioned_count: number;
    last_contact: string | null;
  }>;

  // Step 2: Cluster identities dynamically
  const clusters = new Map<string, Cluster>();

  for (const row of matchingRows) {
    const normalized = normalizeAddress(row.address);
    const localPart = normalizedLocalPart(row.address);
    const domain = normalized.split("@")[1];

    // BUG-011: Infer name from address if no display name exists
    // BUG-015: Skip inference for noreply addresses (they already have correct display names)
    let displayName = row.display_name;
    if (!displayName) {
      // Skip inference for noreply addresses - they're bots, not people
      const isNoreplyAddress = isNoreply(row.address) || 
                               row.address.toLowerCase().includes("noreply") ||
                               row.address.toLowerCase().includes("no-reply");
      if (!isNoreplyAddress) {
        const inferredName = inferNameFromAddress(row.address);
        if (inferredName) {
          displayName = inferredName;
        }
      }
    }

    // Cluster by local-part (consumer domains) or local-part@domain (work domains)
    // BUG-011: Also try fuzzy local-part matching for non-consumer domains
    let clusterKey = CONSUMER_DOMAINS.has(domain)
      ? localPart
      : `${localPart}@${domain}`;

    // Try to find existing cluster with similar local-part (for dot/underscore variations)
    if (!CONSUMER_DOMAINS.has(domain)) {
      const normalizedLocal = localPart.replace(/[._]/g, "");
      for (const [existingKey] of clusters.entries()) {
        if (existingKey.includes("@") && existingKey.split("@")[1] === domain) {
          const existingLocal = existingKey.split("@")[0].replace(/[._]/g, "");
          if (normalizedLocal === existingLocal && normalizedLocal.length >= 3) {
            clusterKey = existingKey;
            break;
          }
        }
      }
    }

    let cluster = clusters.get(clusterKey);
    if (!cluster) {
      cluster = {
        addresses: [],
        displayNames: new Set(),
        identities: [],
        isNoreply: false,
      };
      clusters.set(clusterKey, cluster);
    }

    if (!cluster.addresses.includes(row.address)) {
      cluster.addresses.push(row.address);
    }
    if (displayName) {
      cluster.displayNames.add(displayName);
    }
    cluster.identities.push({
      address: row.address,
      displayName: displayName,
      sentCount: row.sent_count,
      receivedCount: row.received_count,
      mentionedCount: row.mentioned_count,
      lastContact: row.last_contact,
    });
  }

  // Step 3: Merge clusters by display name (nickname matching)
  const nameClusters = new Map<string, Cluster>();
  for (const [key, cluster] of clusters.entries()) {
    const nameKeys: string[] = [];
    for (const displayName of cluster.displayNames) {
      const parsed = parseName(displayName);
      if (parsed.first && parsed.last) {
        const canonicalFirst = canonicalFirstName(parsed.first);
        nameKeys.push(`${canonicalFirst}:${parsed.last}`);
      }
    }
    // BUG-011: If no name keys found, try to merge by inferred name from addresses
    // BUG-015: Skip inference for noreply addresses
    if (nameKeys.length === 0) {
      for (const address of cluster.addresses) {
        // Skip inference for noreply addresses
        const isNoreplyAddress = isNoreply(address) || 
                                 address.toLowerCase().includes("noreply") ||
                                 address.toLowerCase().includes("no-reply");
        if (isNoreplyAddress) continue;
        
        const inferredName = inferNameFromAddress(address);
        if (inferredName) {
          const parsed = parseName(inferredName);
          if (parsed.first && parsed.last) {
            const canonicalFirst = canonicalFirstName(parsed.first);
            nameKeys.push(`${canonicalFirst}:${parsed.last}`);
            // Add inferred name to displayNames for consistency
            cluster.displayNames.add(inferredName);
            break; // Use first inferred name found
          }
        }
      }
    }
    const primaryNameKey = nameKeys.length > 0 ? nameKeys[0] : key;

    let mergedCluster = nameClusters.get(primaryNameKey);
    if (!mergedCluster) {
      mergedCluster = {
        addresses: [],
        displayNames: new Set(),
        identities: [],
        isNoreply: false,
      };
      nameClusters.set(primaryNameKey, mergedCluster);
    }

    for (const addr of cluster.addresses) {
      if (!mergedCluster.addresses.includes(addr)) {
        mergedCluster.addresses.push(addr);
      }
    }
    for (const name of cluster.displayNames) {
      mergedCluster.displayNames.add(name);
    }
    mergedCluster.identities.push(...cluster.identities);
  }

  // Step 4: Apply noreply filtering and build final results
  const people: WhoPerson[] = [];
  const queryPhonetic = doubleMetaphone(queryLower)[0] || "";

  for (const [, cluster] of nameClusters.entries()) {
    // BUG-013: Check noreply addresses
    const noreplyAddresses = cluster.addresses.filter((addr) => isNoreply(addr));
    if (noreplyAddresses.length > 0) {
      cluster.isNoreply = true;
    }
    // BUG-013: Check display names for noreply patterns (e.g., "(via Google Docs)")
    for (const displayName of cluster.displayNames) {
      if (
        displayName.toLowerCase().includes("(via ") ||
        displayName.toLowerCase().includes("via ") ||
        displayName.toLowerCase().includes("noreply") ||
        displayName.toLowerCase().includes("no-reply")
      ) {
        cluster.isNoreply = true;
        break;
      }
    }
    if (cluster.displayNames.size > 10) {
      cluster.isNoreply = true;
    }

    // BUG-013: Apply noreply filter AFTER all checks
    if (!includeNoreply && cluster.isNoreply) continue;

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

    // Get canonical name
    const displayNameArray = Array.from(cluster.displayNames);
    const canonicalName = displayNameArray.length > 0 ? displayNameArray[0] : null;
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
      if (
        identity.lastContact &&
        (!lastContact || identity.lastContact > lastContact)
      ) {
        lastContact = identity.lastContact;
      }
    }

    // BUG-012: Apply filters AFTER merging and aggregation
    if (totalSent < minSent || totalReceived < minReceived) {
      continue;
    }

    // Extract signature data dynamically (from most recent email per address)
    let phone: string | null = null;
    let title: string | null = null;
    let company: string | null = null;
    const urls: string[] = [];
    const altEmails: string[] = [];

    // BUG-014: Skip signature extraction for noreply addresses (they're bots, not people)
    if (!cluster.isNoreply) {
      for (const address of cluster.addresses.slice(0, 3)) {
        // Only check first 3 addresses to limit signature extraction overhead
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
    }

    // Score for fuzzy matching
    let score = 0;
    const nameLower = (canonicalName || "").toLowerCase();
    if (nameLower.includes(queryLower)) score += 100;
    for (const akaName of aka) {
      if (akaName.toLowerCase().includes(queryLower)) score += 50;
    }
    for (const addr of cluster.addresses) {
      if (addr.toLowerCase().includes(queryLower)) score += 25;
    }

    if (canonicalName) {
      const nameParts = canonicalName.toLowerCase().split(/\s+/);
      const firstName = nameParts[0];
      if (firstName) {
        const firstNamePhonetic = doubleMetaphone(firstName)[0] || "";
        if (firstNamePhonetic && firstNamePhonetic === queryPhonetic) {
          score += 75;
        } else if (firstNamePhonetic) {
          const editDist = distance(queryLower, firstName);
          if (editDist <= 1) {
            score += 50 - editDist * 10;
          }
        }
      }
    }

    people.push({
      name: canonicalName,
      aka,
      primaryAddress,
      addresses: cluster.addresses,
      phone,
      title,
      company,
      urls,
      sentCount: totalSent,
      receivedCount: totalReceived,
      mentionedCount: totalMentioned,
      lastContact,
      _score: score, // Internal scoring for sorting
    } as WhoPerson & { _score: number });
  }

  // Sort by score, then by usage
  people.sort((a, b) => {
    const scoreA = (a as WhoPerson & { _score: number })._score || 0;
    const scoreB = (b as WhoPerson & { _score: number })._score || 0;
    if (scoreB !== scoreA) return scoreB - scoreA;
    return (
      b.receivedCount +
      b.sentCount -
      (a.receivedCount + a.sentCount)
    );
  });

  // Remove internal score field and filter out null/empty values
  const finalPeople = people.slice(0, limit).map((p) => {
    const { _score, ...rest } = p as WhoPerson & { _score: number };
    const cleaned: WhoPerson = {
      primaryAddress: rest.primaryAddress,
      addresses: rest.addresses,
      sentCount: rest.sentCount,
      receivedCount: rest.receivedCount,
      mentionedCount: rest.mentionedCount,
      name: rest.name ?? null,
      aka: rest.aka && rest.aka.length > 0 ? rest.aka : [],
      phone: rest.phone ?? null,
      title: rest.title ?? null,
      company: rest.company ?? null,
      urls: rest.urls && rest.urls.length > 0 ? rest.urls : [],
      lastContact: rest.lastContact ?? null,
    };
    
    return cleaned;
  });

  return { query: query.trim(), people: finalPeople };
}
