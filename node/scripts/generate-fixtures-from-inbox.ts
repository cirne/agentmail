#!/usr/bin/env tsx
/**
 * Generate realistic eval fixtures from actual inbox data.
 * Anonymizes personal information while preserving email patterns.
 */

import { closeDb, getDb } from "~/db";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { stringify } from "yaml";

interface MessageRow {
  message_id: string;
  subject: string;
  from_address: string;
  from_name: string | null;
  body_text: string;
  date: string;
  is_noise: number;
  labels: string;
  thread_id: string;
}

// Anonymization mappings
const nameMap = new Map<string, string>();
const emailMap = new Map<string, string>();
let nameCounter = 1;
let emailCounter = 1;

function anonymizeName(name: string | null): string | null {
  if (!name) return null;
  // Normalize: handle case-insensitive matching
  const normalized = name.trim();
  const lower = normalized.toLowerCase();
  
  // Check if we've seen this name (case-insensitive)
  for (const [original, anonymized] of nameMap.entries()) {
    if (original.toLowerCase() === lower) {
      return anonymized;
    }
  }
  
  const anonymized = `Person${nameCounter++}`;
  nameMap.set(normalized, anonymized);
  return anonymized;
}

function anonymizeEmail(email: string): string {
  if (emailMap.has(email)) return emailMap.get(email)!;
  
  // Extract domain
  const [localPart, domain] = email.split("@");
  
  // Keep company domains, anonymize personal domains
  let anonymizedDomain: string;
  if (domain.includes("gmail.com") || domain.includes("yahoo.com") || domain.includes("outlook.com") || domain.includes("icloud.com")) {
    anonymizedDomain = `example${emailCounter++}.com`;
  } else {
    // Keep company domain
    anonymizedDomain = domain;
  }
  
  // Anonymize local part
  const anonymizedLocal = `user${emailCounter}`;
  const anonymized = `${anonymizedLocal}@${anonymizedDomain}`;
  emailMap.set(email, anonymized);
  return anonymized;
}

function anonymizeBodyText(text: string): string {
  // Remove specific purchase details, names, addresses, email addresses
  // Keep structure and general patterns
  let anonymized = text;
  
  // Replace email addresses FIRST (before other processing)
  // Use a more comprehensive regex that handles various formats
  anonymized = anonymized.replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, (email) => {
    return anonymizeEmail(email);
  });
  
  // Replace common first names (common patterns like "Lew", "John", etc.)
  // This is imperfect but helps catch some names
  const commonFirstNames = /\b(Lew|John|Jane|Bob|Alice|Charlie|David|Emma|Frank|Grace|Henry|Ivy|Jack|Kate|Luke|Mary|Nick|Olivia|Paul|Quinn|Rose|Sam|Tom|Uma|Vic|Will|Xara|Yara|Zoe)\b/gi;
  anonymized = anonymized.replace(commonFirstNames, (name) => {
    return anonymizeName(name) || "Person";
  });
  
  // Replace common name patterns (First Last, FirstName LastName, etc.)
  anonymized = anonymized.replace(/\b[A-Z][a-z]+ [A-Z][a-z]+\b/g, (name) => {
    const parts = name.split(" ");
    const first = anonymizeName(parts[0]) || "Person";
    const last = anonymizeName(parts[1]) || "Person";
    return `${first} ${last}`;
  });
  
  // Replace dollar amounts with generic amounts
  anonymized = anonymized.replace(/\$[\d,]+\.?\d*/g, (match) => {
    const amount = parseFloat(match.replace(/[$,]/g, ""));
    if (amount < 10) return "$9.99";
    if (amount < 50) return "$49.99";
    if (amount < 100) return "$99.99";
    if (amount < 500) return "$299.99";
    return "$999.99";
  });
  
  // Replace dates with generic dates
  anonymized = anonymized.replace(/\d{1,2}\/\d{1,2}\/\d{4}/g, "March 15, 2024");
  anonymized = anonymized.replace(/\d{4}-\d{2}-\d{2}/g, "2024-03-15");
  anonymized = anonymized.replace(/February \d{1,2}, \d{4}/g, "March 15, 2024");
  anonymized = anonymized.replace(/March \d{1,2}, \d{4}/g, "March 15, 2024");
  
  // Replace order/transaction IDs
  anonymized = anonymized.replace(/[A-Z0-9]{10,}/g, "ABC123456789");
  
  // Replace phone numbers
  anonymized = anonymized.replace(/\b\d{3}[-.]?\d{3}[-.]?\d{4}\b/g, "555-123-4567");
  anonymized = anonymized.replace(/\b\(\d{3}\)\s?\d{3}[-.]?\d{4}\b/g, "(555) 123-4567");
  
  // Replace URLs but keep domain structure
  anonymized = anonymized.replace(/https?:\/\/[^\s\)]+/g, (url) => {
    try {
      const urlObj = new URL(url.split(")")[0]); // Handle URLs with trailing parens
      return `https://${urlObj.hostname}/...`;
    } catch {
      return "https://example.com/...";
    }
  });
  
  // Truncate very long bodies
  if (anonymized.length > 500) {
    anonymized = anonymized.substring(0, 500) + "...";
  }
  
  return anonymized;
}

function calculateRelativeDate(dateStr: string): string {
  const msgDate = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - msgDate.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  
  if (diffDays === 0) {
    const hours = msgDate.getHours();
    return `today+${hours}h`;
  }
  
  return `-${diffDays}d`;
}

async function main() {
  const db = await getDb();

  const messages = (await (
    await db.prepare(`
    SELECT 
      message_id,
      subject,
      from_address,
      from_name,
      body_text,
      date,
      is_noise,
      labels,
      thread_id
    FROM messages
    ORDER BY date DESC
    LIMIT 500
  `)
  ).all()) as MessageRow[];
  
  console.log(`Found ${messages.length} messages`);
  
  // Group by domain/category for organization
  const byDomain = new Map<string, MessageRow[]>();
  const byCategory = new Map<string, MessageRow[]>();
  
  for (const msg of messages) {
    const domain = msg.from_address.split("@")[1];
    if (!byDomain.has(domain)) {
      byDomain.set(domain, []);
    }
    byDomain.get(domain)!.push(msg);
    
    // Categorize
    let category = "other";
    const subjectLower = msg.subject.toLowerCase();
    const bodyLower = msg.body_text.toLowerCase();
    
    if (subjectLower.includes("receipt") || subjectLower.includes("invoice") || bodyLower.includes("receipt") || bodyLower.includes("invoice")) {
      category = "transactional";
    } else if (subjectLower.includes("meeting") || subjectLower.includes("calendar") || subjectLower.includes("invite")) {
      category = "meetings";
    } else if (msg.is_noise === 1 || subjectLower.includes("newsletter") || subjectLower.includes("unsubscribe")) {
      category = "promotional";
    } else if (subjectLower.startsWith("re:") || subjectLower.includes("reply") || bodyLower.includes("wrote:")) {
      category = "conversations";
    }
    
    if (!byCategory.has(category)) {
      byCategory.set(category, []);
    }
    byCategory.get(category)!.push(msg);
  }
  
  console.log(`Domains: ${byDomain.size}`);
  console.log(`Categories: ${Array.from(byCategory.keys()).join(", ")}`);
  
  // Generate fixtures
  const fixtures: any[] = [];
  
  for (const msg of messages) {
    const anonymizedFromName = anonymizeName(msg.from_name);
    const anonymizedFromAddress = anonymizeEmail(msg.from_address);
    const anonymizedBody = anonymizeBodyText(msg.body_text);
    const anonymizedSubject = anonymizeBodyText(msg.subject); // Reuse body anonymization for subject
    const relativeDate = calculateRelativeDate(msg.date);
    
    const fixture: any = {
      subject: anonymizedSubject,
      fromAddress: anonymizedFromAddress,
      bodyText: anonymizedBody,
      date: relativeDate,
    };
    
    if (anonymizedFromName) {
      fixture.fromName = anonymizedFromName;
    }
    
    if (msg.is_noise === 1) {
      fixture.isNoise = true;
    }
    
    if (msg.labels && msg.labels !== "[]") {
      fixture.labels = msg.labels;
    }
    
    fixtures.push(fixture);
  }
  
  // Write to YAML files organized by category
  const outputDir = join(process.cwd(), "tests/ask");
  
  // Write all to a single comprehensive file
  const allFixtures = {
    messages: fixtures,
  };
  
  writeFileSync(
    join(outputDir, "realistic-inbox.yaml"),
    stringify(allFixtures, { lineWidth: 120, indent: 2 })
  );
  
  console.log(`\nGenerated ${fixtures.length} fixtures in realistic-inbox.yaml`);
  console.log(`Output: ${join(outputDir, "realistic-inbox.yaml")}`);

  await closeDb();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
