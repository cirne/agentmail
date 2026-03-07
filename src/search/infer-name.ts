/**
 * Infer display names from email addresses when no header name exists.
 * Common patterns: firstname.lastname, firstnamelastname, firstname_lastname, flastname
 */

/**
 * Infers a display name from an email address local-part (heuristic only, sync).
 * Returns null if the pattern is ambiguous or can't be inferred.
 * 
 * **When is this used?** Only as a fallback when no display name exists in email headers.
 * 
 * **Confidence levels:**
 * - HIGH: Dot/underscore separators (`first.last`, `first_last`) - always inferred
 * - HIGH: CamelCase (`firstLast`) - always inferred
 * - MEDIUM: All-lowercase requires strong signals (name endings, common names, or high score)
 * - MEDIUM: Single-letter prefix requires short last name (5-6 chars)
 * 
 * Examples:
 * - `lewis.cirne` -> "Lewis Cirne" (dot separator - high confidence)
 * - `katelyn_cirne` -> "Katelyn Cirne" (underscore separator - high confidence)
 * - `alanfinley` -> "Alan Finley" (has "an" ending - medium confidence)
 * - `whitney.allen` -> "Whitney Allen" (dot separator - high confidence)
 * - `whitneyallen` -> "Whitney Allen" (has "ney" ending - medium confidence)
 * - `johnsmith` -> "John Smith" (common first name - medium confidence)
 * - `abrown` -> "A Brown" (single letter + short last name - medium confidence)
 * - `fredbrown` -> null (no strong signal, could be username - correctly rejected)
 * - `sjohnson` -> null (ambiguous: could be "S Johnson" or "Sjohn Son")
 */
export function inferNameFromAddress(address: string): string | null {
  // Strip +aliases before inferring (e.g., "lewis+work" -> "lewis")
  let localPart = address.split("@")[0].toLowerCase();
  if (localPart.includes("+")) {
    localPart = localPart.split("+")[0];
  }
  
  // Pattern 1: firstname.lastname or firstname_lastname
  const dotOrUnderscoreMatch = localPart.match(/^([a-z]+)[._]([a-z]+)$/);
  if (dotOrUnderscoreMatch) {
    const [, first, last] = dotOrUnderscoreMatch;
    // Skip if either part is too short (likely not a name)
    if (first.length >= 2 && last.length >= 2) {
      return capitalizeWords(`${first} ${last}`);
    }
  }
  
  // Pattern 2: firstnamelastname (camelCase detection)
  // Look for transition from lowercase to uppercase (e.g., "lewisCirne")
  // Note: localPart is already lowercased, so we need to check the original
  const originalLocalPart = address.split("@")[0];
  const camelCaseMatch = originalLocalPart.match(/^([a-z]+)([A-Z][a-z]+)$/);
  if (camelCaseMatch) {
    const [, first, last] = camelCaseMatch;
    if (first.length >= 2 && last.length >= 2) {
      return capitalizeWords(`${first.toLowerCase()} ${last.toLowerCase()}`);
    }
  }
  
  // Pattern 3: firstnamelastname (all lowercase, try to split)
  // Skip common non-name words
  const skipWords = ["the", "my", "our", "new", "old", "recipient", "sender", "user", "admin", "support", "info", "contact", "mail", "email", "noreply", "no-reply"];
  
  // Check if entire local-part is a skip word
  if (skipWords.includes(localPart)) {
    return null;
  }
  
  // Try longer first names first (prefer 4-6 chars, then 3, then 7)
  // But require both parts to be reasonable lengths
  // Collect all valid splits and pick the best one
  const validSplits: Array<{ first: string; last: string; score: number }> = [];
  const firstLengths = [4, 5, 6, 3, 7]; // Prefer 4-6 char first names
  for (const i of firstLengths) {
    if (localPart.length < i + 4) continue; // Need at least 4 chars for last name
    const first = localPart.slice(0, i);
    const last = localPart.slice(i);
    
    // Heuristic: both parts should be reasonable name lengths
    // First: 3-7 chars, Last: 4+ chars
    if (first.length >= 3 && first.length <= 7 && last.length >= 4) {
      // Skip common non-name prefixes
      if (skipWords.includes(first)) continue;
      // Additional check: first part should start with a letter that's commonly a name start
      if (skipWords.some(w => localPart.startsWith(w))) continue;
      
      // Reject ambiguous short splits (e.g., "sjoh" + "nson" from "sjohnson")
      // If first is only 3-4 chars and last could be ambiguous, skip
      if (first.length <= 4 && last.length <= 6) {
        const ambiguousEndings = ["son", "sen", "man", "ton"];
        if (ambiguousEndings.some(ending => last.endsWith(ending))) {
          continue; // Too ambiguous
        }
      }
      
      // Score splits: prefer 4-6 char first names, longer last names
      // Also boost score for common first name endings (e.g., -an, -en, -in, -on, -er, -el, -al)
      let score = 0;
      if (first.length >= 4 && first.length <= 6) score += 10; // Prefer common first name lengths
      // But also accept longer first names (7-8 chars) if they have good endings
      if (first.length >= 7 && first.length <= 8) score += 8; // Slightly lower but still good
      if (last.length >= 5) score += 5; // Prefer longer last names
      // Weight last name length less heavily to avoid favoring very long last names
      score += Math.min(last.length, 7); // Cap at 7 to avoid over-weighting very long names
      
      // Boost score for common first name endings (heuristic for natural split points)
      const commonEndings = ["an", "en", "in", "on", "er", "el", "al", "ey", "ey", "ly", "ie", "ney", "ley"];
      if (commonEndings.some(ending => first.endsWith(ending))) {
        score += 6; // Strong boost for natural name endings
      }
      
      // Penalize splits where last name is much longer than first name (unbalanced)
      if (last.length > first.length + 3) {
        score -= 2; // Slight penalty for very unbalanced splits
      }
      
      // Boost score if last name starts with consonant (more common for last names)
      // Note: include 'n' which was missing
      if (/^[bcdfghjklmnprstvwxyz]/.test(last[0])) {
        score += 2;
      }
      
      validSplits.push({ first, last, score });
    }
  }
  
  // Return the best split (highest score) only if confidence is high enough
  // For all-lowercase patterns without separators, we need stronger signals
  // to avoid false positives like "fredbrown" (could be username, not "Fred Brown")
  if (validSplits.length > 0) {
    validSplits.sort((a, b) => b.score - a.score);
    const best = validSplits[0];
    
    // For all-lowercase patterns without separators, require EITHER:
    // 1. A common name ending (strong signal it's a name), OR
    // 2. A very high score (24+) indicating very clear pattern, OR
    // 3. Common first names that don't have endings but are very recognizable
    // Examples that pass: "alanfinley" (has "an" ending), "whitneyallen" (has "ney" ending), "johnsmith" (common name, high score)
    // Examples that fail: "fredbrown" (no name ending, score ~22, could be username)
    const commonEndings = ["an", "en", "in", "on", "er", "el", "al", "ey", "ly", "ie", "ney", "ley"];
    const hasNameEnding = commonEndings.some(ending => best.first.endsWith(ending));
    
    // Common first names that are recognizable even without endings
    const commonFirstNames = ["john", "jane", "mary", "mike", "dave", "bob", "tom", "tim", "dan", "sam", "ben", "joe"];
    const isCommonFirstName = commonFirstNames.includes(best.first);
    
    // Minimum confidence: require score >= 20 AND (name ending OR score >= 24 OR common first name)
    const MIN_CONFIDENCE_SCORE = 20;
    const HIGH_CONFIDENCE_SCORE = 24;
    if (best.score >= MIN_CONFIDENCE_SCORE && (hasNameEnding || best.score >= HIGH_CONFIDENCE_SCORE || isCommonFirstName)) {
      return capitalizeWords(`${best.first} ${best.last}`);
    }
  }
  
  // Pattern 4: Single-letter prefix (e.g., "abrown" -> "A Brown")
  // Only try this if no good multi-letter split was found
  // Be conservative: reject if last name is 7+ chars (likely a username, not "Initial Lastname")
  const singleLetterMatch = localPart.match(/^([a-z])([a-z]{5,})$/);
  if (singleLetterMatch) {
    const [, initial, last] = singleLetterMatch;
    // Only accept if last part looks like a real name (starts with consonant, reasonable length)
    // Require 5-6 chars (common last names like "Brown", "Smith" are 5 chars)
    // Reject 7+ chars as they're likely usernames (e.g., "fredbrown" -> "F Redbrown" is wrong)
    // Last names typically start with consonants
    // Reject if last part ends with common last name endings that suggest it could be split (ambiguous)
    const ambiguousEndings = ["son", "sen", "man", "ton"];
    const looksAmbiguous = ambiguousEndings.some(ending => last.endsWith(ending) && last.length <= 7);
    // Cap at 6 chars to avoid usernames like "fredbrown" -> "F Redbrown"
    if (last.length >= 5 && last.length <= 6 && /^[bcdfghjklmnpqrstvwxyz]/.test(last[0]) && !looksAmbiguous) {
      return capitalizeWords(`${initial.toUpperCase()} ${last}`);
    }
  }
  
  return null;
}

/**
 * Infers name components, company, and type using LLM only (no heuristic fallback).
 * Used when user explicitly requests name inference via flag.
 * 
 * @param address Email address to infer from
 * @returns Inferred data or null, and whether LLM was used
 */
export async function inferNameFromAddressWithLLM(
  address: string
): Promise<{ 
  firstname: string | null; 
  lastname: string | null; 
  company: string | null; 
  type: "person" | "group" | "company" | "other";
  usedLLM: boolean; 
  hint?: string;
  // Convenience: full name if both parts exist
  name?: string | null;
}> {
  // Use LLM directly (no heuristic fallback when flag is set)
  try {
    const { inferNameFromAddressLLM } = await import("./infer-name-llm");
    const llmResult = await inferNameFromAddressLLM(address);
    if (llmResult) {
      const name = llmResult.firstname && llmResult.lastname
        ? `${llmResult.firstname} ${llmResult.lastname}`
        : llmResult.firstname || llmResult.lastname || null;
      return { 
        ...llmResult, 
        name,
        usedLLM: true 
      };
    }
  } catch (error) {
    // LLM unavailable or failed
  }

  return {
    firstname: null,
    lastname: null,
    company: null,
    type: "other",
    name: null,
    usedLLM: false,
    hint: "LLM inference unavailable. Ensure ZMAIL_OPENAI_API_KEY is set.",
  };
}

/**
 * Capitalize words (first letter uppercase, rest lowercase).
 */
function capitalizeWords(str: string): string {
  return str
    .split(/\s+/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");
}
