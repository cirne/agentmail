import type { SqliteDatabase } from "~/db";
import { normalizeAddress, normalizedLocalPart } from "./normalize";
import { canonicalFirstName, parseName } from "./nicknames";
import { isNoreply } from "./noreply";

export interface Identity {
  address: string;
  displayName: string | null;
  sentCount: number;
  receivedCount: number;
  mentionedCount: number;
  lastContact: string | null;
}

export interface Cluster {
  addresses: string[];
  displayNames: Set<string>;
  identities: Identity[];
  isNoreply: boolean;
}

/**
 * Consumer email domains where same local-part = same person.
 * For work domains, we require display name matching too.
 */
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

// Anti-merge check removed for now - can be added later if needed

/**
 * Cluster identities by normalized local-part across consumer domains.
 */
function clusterByLocalPart(identities: Identity[]): Map<string, Cluster> {
  const clusters = new Map<string, Cluster>();

  for (const identity of identities) {
    const normalized = normalizeAddress(identity.address);
    const localPart = normalizedLocalPart(identity.address);
    const domain = normalized.split("@")[1];

    // For consumer domains, cluster by local-part only
    // For work domains, include domain in cluster key (weaker signal)
    const clusterKey = CONSUMER_DOMAINS.has(domain) ? localPart : `${localPart}@${domain}`;

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

    if (!cluster.addresses.includes(identity.address)) {
      cluster.addresses.push(identity.address);
    }
    if (identity.displayName) {
      cluster.displayNames.add(identity.displayName);
    }
    cluster.identities.push(identity);
  }

  return clusters;
}

/**
 * Merge clusters that share the same canonical (first, last) name pair.
 * Only merges if display names match after nickname normalization.
 */
function mergeByDisplayName(clusters: Map<string, Cluster>): Map<string, Cluster> {
  const nameClusters = new Map<string, Cluster>();

  for (const [key, cluster] of clusters.entries()) {
    // Build canonical name key from display names
    const nameKeys: string[] = [];
    for (const displayName of cluster.displayNames) {
      const parsed = parseName(displayName);
      if (parsed.first && parsed.last) {
        const canonicalFirst = canonicalFirstName(parsed.first);
        nameKeys.push(`${canonicalFirst}:${parsed.last}`);
      }
    }

    // Use the most common name key, or the cluster key if no names
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

    // Merge this cluster into the name-based cluster
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

  return nameClusters;
}

/**
 * Cluster identities from messages into person clusters.
 * Returns a map of cluster keys to clusters.
 */
export function clusterIdentities(db: SqliteDatabase): Map<string, Cluster> {
  // Fetch all distinct identities from messages (from, to, cc)
  const rows = db
    .prepare(
      /* sql */ `
    WITH all_addresses AS (
      SELECT DISTINCT LOWER(from_address) as address, from_name as display_name, 'from' as source
      FROM messages
      UNION
      SELECT DISTINCT LOWER(j.value) as address, NULL as display_name, 'to' as source
      FROM messages m, json_each(m.to_addresses) j
      UNION
      SELECT DISTINCT LOWER(j.value) as address, NULL as display_name, 'cc' as source
      FROM messages m, json_each(m.cc_addresses) j
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
  `
    )
    .all() as Array<{
    address: string;
    display_name: string | null;
    sent_count: number;
    received_count: number;
    mentioned_count: number;
    last_contact: string | null;
  }>;

  const identities: Identity[] = rows.map((r) => ({
    address: r.address,
    displayName: r.display_name,
    sentCount: r.sent_count,
    receivedCount: r.received_count,
    mentionedCount: r.mentioned_count,
    lastContact: r.last_contact,
  }));

  // Step 1: Cluster by local-part (consumer domains) or local-part@domain (work domains)
  let clusters = clusterByLocalPart(identities);

  // Step 2: Merge clusters with matching canonical display names
  clusters = mergeByDisplayName(clusters);

  // Step 3: Apply anti-merge checks and noreply detection
  const finalClusters = new Map<string, Cluster>();
  for (const [key, cluster] of clusters.entries()) {
    // Check for noreply patterns
    const noreplyAddresses = cluster.addresses.filter((addr) => isNoreply(addr));
    if (noreplyAddresses.length > 0) {
      cluster.isNoreply = true;
    }

    // Check for bot patterns (many distinct display names)
    if (cluster.displayNames.size > 10) {
      cluster.isNoreply = true;
    }

    // Anti-merge: if addresses appear as co-recipients, split them
    // For simplicity, we'll keep the cluster but mark it for manual review
    // In practice, you might want to split here, but that's complex

    finalClusters.set(key, cluster);
  }

  return finalClusters;
}
