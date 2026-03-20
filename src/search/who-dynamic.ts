import type { SqliteDatabase } from "~/db";
import type { WhoPerson, WhoResult } from "~/lib/types";
import { normalizeAddress, normalizedLocalPart } from "./normalize";
import { canonicalFirstName, parseName, parsePersonName } from "./nicknames";
import { isNoreply } from "./noreply";
import { extractSignatureData } from "./signature";
import { inferNameFromAddress, inferNameFromAddressWithLLM } from "./infer-name";
import doubleMetaphone from "double-metaphone";
import { distance } from "fastest-levenshtein";

export interface WhoOptions {
  query: string;
  limit?: number;
  minSent?: number;
  minReceived?: number;
  includeNoreply?: boolean;
  ownerAddress?: string;
  /** Use LLM (GPT-4.1 nano) to guess names from email addresses. Requires ZMAIL_OPENAI_API_KEY. */
  enrich?: boolean;
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
 * 
 * When enrich is true, performs async LLM inference to guess names from email addresses.
 */
export async function whoDynamic(db: SqliteDatabase, opts: WhoOptions): Promise<WhoResult> {
  const {
    query,
    limit = DEFAULT_LIMIT,
    minSent = 0,
    minReceived = 0,
    includeNoreply = false,
  } = opts;

  const queryLower = query.trim().toLowerCase();
  const pattern = `%${queryLower}%`;

  const matchingRows = (await (
    await db.prepare(
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
        (SELECT COUNT(*) FROM messages m 
         WHERE EXISTS (SELECT 1 FROM json_each(m.to_addresses) WHERE LOWER(value) = a.address)
            OR EXISTS (SELECT 1 FROM json_each(m.cc_addresses) WHERE LOWER(value) = a.address)) as mentioned_count,
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
  ).all(
    pattern,
    pattern,
    pattern,
    pattern,
    limit * 10
  )) as Array<{
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
        if (opts.enrich) {
          // Mark for LLM inference (will be processed later)
          (row as typeof row & { _needsLLM?: boolean })._needsLLM = true;
        } else {
          // Use heuristic inference
          const inferredName = inferNameFromAddress(row.address);
          if (inferredName) {
            displayName = inferredName;
          }
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

    if (!cluster.addresses.includes(normalized)) {
      cluster.addresses.push(normalized);
    }
    if (displayName) {
      cluster.displayNames.add(displayName);
    }
    
    // Track addresses that need LLM inference
    if (opts.enrich && !displayName && (row as typeof row & { _needsLLM?: boolean })._needsLLM) {
      (cluster as typeof cluster & { _needsLLM?: string[] })._needsLLM = 
        ((cluster as typeof cluster & { _needsLLM?: string[] })._needsLLM || []);
      if (!(cluster as typeof cluster & { _needsLLM?: string[] })._needsLLM!.includes(normalized)) {
        (cluster as typeof cluster & { _needsLLM?: string[] })._needsLLM!.push(normalized);
      }
    }
    
    cluster.identities.push({
      address: normalized,
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
        
        if (opts.enrich) {
          // Mark for LLM inference (will be processed later)
          (cluster as typeof cluster & { _needsLLM?: string[] })._needsLLM = 
            ((cluster as typeof cluster & { _needsLLM?: string[] })._needsLLM || []);
          (cluster as typeof cluster & { _needsLLM?: string[] })._needsLLM!.push(address);
        } else {
          // Use heuristic inference
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
    
    // Preserve LLM needs when merging clusters
    const clusterNeedsLLM = (cluster as typeof cluster & { _needsLLM?: string[] })._needsLLM;
    if (clusterNeedsLLM && clusterNeedsLLM.length > 0) {
      (mergedCluster as typeof mergedCluster & { _needsLLM?: string[] })._needsLLM = 
        ((mergedCluster as typeof mergedCluster & { _needsLLM?: string[] })._needsLLM || []);
      for (const addr of clusterNeedsLLM) {
        if (!(mergedCluster as typeof mergedCluster & { _needsLLM?: string[] })._needsLLM!.includes(addr)) {
          (mergedCluster as typeof mergedCluster & { _needsLLM?: string[] })._needsLLM!.push(addr);
        }
      }
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

    // Parse name into firstname/lastname if it's a person name, otherwise keep as name
    const personName = canonicalName ? parsePersonName(canonicalName) : null;

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

    // Build person object with firstname/lastname if parseable, otherwise use name
    const person: WhoPerson & { _score: number } = {
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
    };

    if (personName) {
      // Person name - use firstname/lastname
      person.firstname = personName.firstname;
      person.lastname = personName.lastname;
    } else if (canonicalName) {
      // Company/group/other - use name field
      person.name = canonicalName;
    }

    people.push(person);
  }

  // If enrich flag is set, try LLM inference for clusters that need it
  if (opts.enrich) {
    const llmPromises: Array<Promise<void>> = [];
    for (const [, cluster] of nameClusters.entries()) {
      const needsLLM = (cluster as typeof cluster & { _needsLLM?: string[] })._needsLLM;
      if (needsLLM && needsLLM.length > 0) {
        // Try LLM for each address that needs it
        for (const address of needsLLM) {
          llmPromises.push(
            inferNameFromAddressWithLLM(address).then((result) => {
              if (result.usedLLM && result.name) {
                cluster.displayNames.add(result.name);
                // Find the person entry and update with LLM results
                const person = people.find((p) => 
                  p.addresses.includes(address) || p.primaryAddress === address
                );
                if (person) {
                  // Update with LLM results
                  if (result.firstname && result.lastname) {
                    // Person name - use firstname/lastname
                    person.firstname = result.firstname;
                    person.lastname = result.lastname;
                    // Remove name field if it exists (LLM result takes precedence)
                    delete person.name;
                  } else if (result.firstname || result.lastname) {
                    // Partial name - use name field
                    person.name = [result.firstname, result.lastname].filter(Boolean).join(" ") || null;
                    delete person.firstname;
                    delete person.lastname;
                  } else if (result.name) {
                    // Non-person name (company/group) - use name field
                    person.name = result.name;
                    delete person.firstname;
                    delete person.lastname;
                  }
                  // Update company if inferred
                  if (result.company) {
                    person.company = result.company;
                  }
                }
              }
            }).catch(() => {
              // Silently fail - LLM inference is optional
            })
          );
        }
      }
    }
    // Wait for all LLM calls to complete
    await Promise.all(llmPromises);

    // Post-LLM merge: Merge clusters with matching last names and compatible first names
    // This handles cases like "Alan Finley" and "A Finley" that should be the same person
    const mergedPeople: WhoPerson[] = [];
    const mergedAddresses = new Set<string>();

    for (const person of people) {
      if (mergedAddresses.has(person.primaryAddress)) continue;

      // Find other people with matching last name and compatible first name
      const matchingPeople = [person];
      
      // Parse person's name components
      let personLast = person.lastname?.toLowerCase() || null;
      let personFirst = person.firstname?.toLowerCase() || null;
      if (!personLast && person.name) {
        // Try to parse name field
        const parsed = parsePersonName(person.name);
        if (parsed && parsed.lastname) {
          personFirst = parsed.firstname.toLowerCase();
          personLast = parsed.lastname.toLowerCase();
        } else if (person.name && !person.name.includes(" ")) {
          // Single word name - might be concatenated (e.g., "Afinley" = "A" + "Finley")
          // Try to match against other person's lastname
          const nameLower = person.name.toLowerCase();
          // If it ends with a known lastname from another person, extract it
          for (const other of people) {
            if (other === person) continue;
            const otherLast = other.lastname?.toLowerCase();
            if (otherLast && nameLower.endsWith(otherLast) && nameLower.length > otherLast.length) {
              personFirst = nameLower.slice(0, -otherLast.length);
              personLast = otherLast;
              break;
            }
          }
        }
      }
      
      for (const other of people) {
        if (other === person || mergedAddresses.has(other.primaryAddress)) continue;
        
        // Parse other's name components
        let otherLast = other.lastname?.toLowerCase() || null;
        let otherFirst = other.firstname?.toLowerCase() || null;
        if (!otherLast && other.name) {
          // Try to parse name field
          const parsed = parsePersonName(other.name);
          if (parsed && parsed.lastname) {
            otherFirst = parsed.firstname.toLowerCase();
            otherLast = parsed.lastname.toLowerCase();
          } else if (other.name && !other.name.includes(" ")) {
            // Single word name - might be concatenated (e.g., "Afinley" = "A" + "Finley")
            // Try to match against person's lastname
            const nameLower = other.name.toLowerCase();
            if (personLast && nameLower.endsWith(personLast) && nameLower.length > personLast.length) {
              otherFirst = nameLower.slice(0, -personLast.length);
              otherLast = personLast;
            }
          }
        }
        
        // Both must have lastname (after parsing)
        if (!personLast || !otherLast) continue;
        
        // Last names must match (case-insensitive)
        if (personLast !== otherLast) continue;
        
        // Check if first names are compatible (one is prefix/abbreviation of the other)
        if (personFirst && otherFirst) {
          // Check if one is a prefix of the other (e.g., "a" matches "alan", "al" matches "alan")
          const shorter = personFirst.length < otherFirst.length ? personFirst : otherFirst;
          const longer = personFirst.length >= otherFirst.length ? personFirst : otherFirst;
          
          if (longer.startsWith(shorter) && shorter.length >= 1) {
            matchingPeople.push(other);
          }
        } else if (!personFirst && !otherFirst) {
          // Both have no first name but same last name - could be same person
          matchingPeople.push(other);
        } else if (personFirst && !otherFirst) {
          // Person has first name, other doesn't - still match if last names match
          matchingPeople.push(other);
        } else if (!personFirst && otherFirst) {
          // Other has first name, person doesn't - still match if last names match
          matchingPeople.push(other);
        }
      }

      if (matchingPeople.length > 1) {
        // Merge: use the person with the most complete name (longest firstname) or most usage
        matchingPeople.sort((a, b) => {
          const aFirstLen = a.firstname?.length || 0;
          const bFirstLen = b.firstname?.length || 0;
          if (bFirstLen !== aFirstLen) return bFirstLen - aFirstLen;
          return (b.sentCount + b.receivedCount) - (a.sentCount + a.receivedCount);
        });

        const merged = matchingPeople[0];
        const mergedAddressSet = new Set(merged.addresses);
        
        // Merge addresses and counts from all matching people
        for (let i = 1; i < matchingPeople.length; i++) {
          const other = matchingPeople[i];
          for (const addr of other.addresses) {
            if (!mergedAddressSet.has(addr)) {
              merged.addresses.push(addr);
              mergedAddressSet.add(addr);
            }
          }
          merged.sentCount += other.sentCount;
          merged.receivedCount += other.receivedCount;
          merged.mentionedCount += other.mentionedCount;
          
          // Use the most complete name
          // Parse other's name if needed
          let otherFirst = other.firstname;
          let otherLast = other.lastname;
          if (!otherFirst && !otherLast && other.name) {
            const parsed = parsePersonName(other.name);
            if (parsed) {
              otherFirst = parsed.firstname;
              otherLast = parsed.lastname;
            }
          }
          
          if (!merged.firstname && otherFirst) {
            merged.firstname = otherFirst;
            merged.lastname = otherLast || merged.lastname;
            delete merged.name;
          } else if (merged.firstname && otherFirst && otherFirst.length > merged.firstname.length) {
            merged.firstname = otherFirst;
            merged.lastname = otherLast || merged.lastname;
          } else if (!merged.firstname && !merged.lastname && otherFirst && otherLast) {
            // Merged has no name, use other's
            merged.firstname = otherFirst;
            merged.lastname = otherLast;
            delete merged.name;
          }
          
          // Merge company if available
          if (!merged.company && other.company) {
            merged.company = other.company;
          }
          
          mergedAddresses.add(other.primaryAddress);
        }

        mergedPeople.push(merged);
        mergedAddresses.add(merged.primaryAddress);
      } else {
        mergedPeople.push(person);
        mergedAddresses.add(person.primaryAddress);
      }
    }

    // Replace people array with merged results
    people.length = 0;
    people.push(...mergedPeople);
  }

  // Recalculate scores after merging (if merge happened)
  for (const person of people) {
    if ((person as WhoPerson & { _score?: number })._score === undefined) {
      // Recalculate score for merged person
      let score = 0;
      if (person.firstname && person.lastname) score += 10;
      if (person.company) score += 5;
      score += person.sentCount * 2;
      score += person.receivedCount;
      (person as WhoPerson & { _score: number })._score = score;
    }
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
    const cleaned: Partial<WhoPerson> = {
      primaryAddress: rest.primaryAddress,
      addresses: rest.addresses,
      sentCount: rest.sentCount,
      receivedCount: rest.receivedCount,
      mentionedCount: rest.mentionedCount,
      phone: rest.phone ?? null,
      title: rest.title ?? null,
      company: rest.company ?? null,
      lastContact: rest.lastContact ?? null,
    };
    
    // Include firstname/lastname if present, otherwise name
    // Check if firstname/lastname exist (even if null)
    if (rest.firstname !== undefined || rest.lastname !== undefined) {
      cleaned.firstname = rest.firstname ?? null;
      cleaned.lastname = rest.lastname ?? null;
    } else if (rest.name !== undefined) {
      cleaned.name = rest.name ?? null;
    } else {
      // No name at all - set to null for consistency
      cleaned.name = null;
    }
    
    // Only include aka and urls if they have values
    if (rest.aka && rest.aka.length > 0) {
      cleaned.aka = rest.aka;
    }
    if (rest.urls && rest.urls.length > 0) {
      cleaned.urls = rest.urls;
    }
    
    return cleaned as WhoPerson;
  });

  const result: WhoResult = { query: query.trim(), people: finalPeople };
  
  // Add hint if enrich flag wasn't used and we have results
  // The hint is always useful since enrich provides better name inference and deduplication
  if (!opts.enrich && finalPeople.length > 0) {
    result.hint = "Tip: Use --enrich flag for more accurate name inference and better deduplication (adds ~1-2s latency)";
  }
  
  return result;
}
