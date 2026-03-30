import { findPhoneNumbersInText } from "libphonenumber-js";

export interface ExtractedSignature {
  phone: string | null;
  title: string | null;
  company: string | null;
  urls: string[];
  altEmails: string[];
}

/**
 * Extract signature block from email body text.
 * Looks for common signature separators or falls back to detecting short lines near the end.
 */
export function extractSignature(bodyText: string): string | null {
  if (!bodyText || bodyText.length < 20) return null;

  const lines = bodyText.split("\n");
  if (lines.length < 3) return null;

  // Look for RFC 3676 signature separator: "-- " on its own line
  let sigStartIndex = -1;
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 20); i--) {
    if (lines[i].trim() === "--") {
      sigStartIndex = i + 1;
      break;
    }
  }

  // Fallback: look for "___" or "---" separator
  if (sigStartIndex === -1) {
    for (let i = lines.length - 1; i >= Math.max(0, lines.length - 20); i--) {
      const trimmed = lines[i].trim();
      if (trimmed === "___" || trimmed === "---" || trimmed.startsWith("___") || trimmed.startsWith("---")) {
        sigStartIndex = i + 1;
        break;
      }
    }
  }

  // Fallback: look for blank line gap followed by short lines
  // First, find where quoted replies start to avoid detecting them as signatures
  let maxSearchIndex = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim().toLowerCase();
    const nextLine = i + 1 < lines.length ? lines[i + 1].trim().toLowerCase() : "";
    // Stop searching at quoted reply patterns
    if (
      line.match(/^on .+ wrote:$/i) ||
      (line.match(/^on .+$/i) && nextLine.match(/wrote:?$/i)) || // Multi-line "On ... wrote:"
      line.match(/^from: .+$/i) ||
      line.match(/^sent: .+$/i) ||
      line.match(/^date: .+$/i) ||
      line.match(/^subject: .+$/i) ||
      (line.startsWith(">") && i > 5) // Quoted text (but allow early ">" which might be formatting)
    ) {
      maxSearchIndex = i;
      break;
    }
  }

  if (sigStartIndex === -1) {
    // Search backwards from maxSearchIndex (before quoted replies)
    const searchEnd = Math.min(maxSearchIndex, lines.length);
    // Look for blank lines and check if what follows looks like a signature
    // Collect all candidate signatures and pick the best one (earliest with most elements)
    let bestCandidate: { index: number; score: number } | null = null;
    
    for (let i = searchEnd - 1; i >= Math.max(0, searchEnd - 20); i--) {
      if (lines[i].trim() === "" && i < searchEnd - 2) {
        const candidateLines = lines.slice(i + 1, maxSearchIndex);
        const nonEmptyLines = candidateLines.filter((l) => l.trim().length > 0);
        
        // Check if this looks like a signature (not a quoted reply)
        let looksLikeSignature = false;
        let hasName = false;
        let hasCompanyOrEmail = false;
        let hasPhone = false;
        
        for (const line of nonEmptyLines.slice(0, 6)) { // Check first 6 non-empty lines
          const trimmed = line.trim();
          const lower = trimmed.toLowerCase();
          
          // Reject if it looks like a quoted reply header
          if (
            lower.match(/^on .+ wrote:$/i) ||
            lower.match(/^from: .+$/i) ||
            lower.match(/^sent: .+$/i) ||
            lower.match(/^date: .+$/i) ||
            lower.match(/^subject: .+$/i)
          ) {
            looksLikeSignature = false;
            break;
          }
          
          // Check for signature elements
          if (trimmed.length < 80 && !trimmed.match(/^>/)) {
            // Remove formatting markers (asterisks, underscores, etc.)
            const cleanLine = trimmed.replace(/[*_~`]/g, "").trim();
            
            // Looks like a name (capitalized, 2-4 words, possibly with formatting)
            if (cleanLine.match(/^[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,3}$/) && !hasName) {
              hasName = true;
              looksLikeSignature = true;
            }
            // Company name pattern
            if (trimmed.match(/\b(inc|llc|ltd|corp|corporation|company|co)\.?$/i)) {
              hasCompanyOrEmail = true;
              looksLikeSignature = true;
            }
            // Email address
            if (trimmed.match(/[\w.+-]+@[\w.-]+\.\w{2,}/i)) {
              hasCompanyOrEmail = true;
              looksLikeSignature = true;
            }
            // Phone number
            if (trimmed.match(/[\d\s().-]{10,}/)) {
              hasPhone = true;
              looksLikeSignature = true;
            }
          }
        }
        
        // Require at least 2 signature elements (name + company/email/phone)
        const signatureElementCount = (hasName ? 1 : 0) + (hasCompanyOrEmail ? 1 : 0) + (hasPhone ? 1 : 0);
        if (looksLikeSignature && signatureElementCount >= 2 && nonEmptyLines.length >= 2) {
          // Score: prefer signatures with name (more complete)
          const score = signatureElementCount * 10 + (hasName ? 5 : 0);
          if (!bestCandidate || score > bestCandidate.score) {
            bestCandidate = { index: i + 1, score };
          }
        }
      }
    }
    
    if (bestCandidate) {
      sigStartIndex = bestCandidate.index;
    }
  }

  if (sigStartIndex === -1 || sigStartIndex >= lines.length) return null;

  // Find where signature ends (stop at quoted reply patterns)
  let sigEndIndex = Math.min(maxSearchIndex, lines.length);

  const signatureLines = lines.slice(sigStartIndex, sigEndIndex);
  let signatureText = signatureLines.join("\n").trim();

  // Strip common boilerplate
  signatureText = signatureText.replace(/Sent from my iPhone/gi, "");
  signatureText = signatureText.replace(/Get Outlook for (iOS|Android|Windows)/gi, "");
  signatureText = signatureText.replace(/Sent from my (iPad|Android device)/gi, "");

  return signatureText.length > 0 ? signatureText : null;
}

/**
 * Parse signature block to extract structured data.
 */
export function parseSignatureBlock(signatureText: string, senderAddress: string): ExtractedSignature {
  const result: ExtractedSignature = {
    phone: null,
    title: null,
    company: null,
    urls: [],
    altEmails: [],
  };

  if (!signatureText) return result;

  const lines = signatureText.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);

  // Extract phone numbers using libphonenumber-js
  try {
    const phoneNumbers = findPhoneNumbersInText(signatureText, "US");
    if (phoneNumbers.length > 0) {
      // Use the first phone number found
      const phone = phoneNumbers[0];
      result.phone = phone.number.number;
    }
  } catch (err) {
    // Ignore phone parsing errors
  }

  // Extract URLs
  const urlRegex = /https?:\/\/[^\s]+/gi;
  const urls = signatureText.match(urlRegex) || [];
  // BUG-014: Filter out tracking/unsubscribe URLs
  result.urls = urls
    .map((url) => url.trim())
    .filter((url) => {
      const lower = url.toLowerCase();
      return (
        !lower.includes("unsubscribe") &&
        !lower.includes("tracking") &&
        !lower.includes("utm_") &&
        !lower.includes("utm_source") &&
        !lower.includes("utm_medium") &&
        !lower.includes("utm_campaign") &&
        !lower.includes("clicktracking") &&
        !lower.includes("emailtracking")
      );
    });

  // Extract alternative emails (exclude sender's own address)
  const emailRegex = /[\w.+-]+@[\w.-]+\.\w{2,}/gi;
  const emails = signatureText.match(emailRegex) || [];
  const senderLower = senderAddress.toLowerCase();
  result.altEmails = emails
    .map((e) => e.toLowerCase())
    .filter((e) => e !== senderLower);

  // Extract title/company from short lines matching patterns
  for (const line of lines) {
    if (line.length > 80) continue; // Skip long lines
    if (urlRegex.test(line)) continue; // Skip lines that are just URLs
    if (phoneRegex.test(line)) continue; // Skip lines that are just phone numbers

    // BUG-014: Reject boilerplate patterns
    const lowerLine = line.toLowerCase();
    
    // Reject copyright notices
    if (
      lowerLine.includes("(c)") ||
      lowerLine.includes("copyright") ||
      lowerLine.includes("©") ||
      lowerLine.match(/\(c\)\s*\d{4}/)
    ) {
      continue;
    }
    
    // Reject mailing addresses (patterns like street addresses, ZIP codes)
    if (
      lowerLine.match(/\d+\s+[a-z\s]+(street|st|avenue|ave|road|rd|drive|dr|boulevard|blvd|way|place|pl|lane|ln)[\s,]/i) ||
      lowerLine.match(/\d{5}(-\d{4})?/i) || // ZIP code
      lowerLine.match(/[a-z\s]+,\s*[a-z]{2}\s+\d{5}/i) // City, State ZIP
    ) {
      continue;
    }

    // Pattern: "Title, Company"
    const commaMatch = line.match(/^(.+?),\s*(.+)$/);
    if (commaMatch) {
      const [, titlePart, companyPart] = commaMatch;
      // BUG-014: Additional validation - reject if looks like boilerplate
      const titleLower = titlePart.toLowerCase().trim();
      const companyLower = companyPart.toLowerCase().trim();
      if (
        titleLower.length < 50 &&
        companyLower.length < 50 &&
        !titleLower.match(/\(c\)|copyright|©/) &&
        !companyLower.match(/\d+\s+[a-z\s]+(street|st|avenue|ave)/i) &&
        !companyLower.match(/\d{5}/) // No ZIP codes
      ) {
        result.title = titlePart.trim();
        result.company = companyPart.trim();
        break;
      }
    }

    // Pattern: "Title | Company"
    const pipeMatch = line.match(/^(.+?)\s*\|\s*(.+)$/);
    if (pipeMatch) {
      const [, titlePart, companyPart] = pipeMatch;
      const titleLower = titlePart.toLowerCase().trim();
      const companyLower = companyPart.toLowerCase().trim();
      if (
        titleLower.length < 50 &&
        companyLower.length < 50 &&
        !titleLower.match(/\(c\)|copyright|©/) &&
        !companyLower.match(/\d+\s+[a-z\s]+(street|st|avenue|ave)/i) &&
        !companyLower.match(/\d{5}/)
      ) {
        result.title = titlePart.trim();
        result.company = companyPart.trim();
        break;
      }
    }

    // Pattern: "Title at Company"
    const atMatch = line.match(/^(.+?)\s+at\s+(.+)$/i);
    if (atMatch) {
      const [, titlePart, companyPart] = atMatch;
      const titleLower = titlePart.toLowerCase().trim();
      const companyLower = companyPart.toLowerCase().trim();
      if (
        titleLower.length < 50 &&
        companyLower.length < 50 &&
        !titleLower.match(/\(c\)|copyright|©/) &&
        !companyLower.match(/\d+\s+[a-z\s]+(street|st|avenue|ave)/i) &&
        !companyLower.match(/\d{5}/)
      ) {
        result.title = titlePart.trim();
        result.company = companyPart.trim();
        break;
      }
    }

    // Pattern: Standalone company name (common patterns like "Company Inc.", "Company LLC", etc.)
    // Only extract if we haven't found a company yet and line looks like a company name
    if (!result.company && !result.title) {
      const companyPatterns = [
        /\b(inc|llc|ltd|corp|corporation|company|co)\.?$/i, // Ends with Inc., LLC, etc.
        /^[A-Z][a-zA-Z\s&]+(?:Inc|LLC|Ltd|Corp|Corporation|Company|Co)\.?$/i, // Capitalized company name
      ];
      
      const looksLikeCompany = companyPatterns.some(pattern => pattern.test(line)) &&
        line.length > 3 &&
        line.length < 60 &&
        !lowerLine.match(/^on .+ wrote$/i) && // Not a quoted reply header
        !lowerLine.match(/^from:/i) &&
        !lowerLine.match(/^sent:/i) &&
        !lowerLine.match(/^date:/i) &&
        !lowerLine.match(/^subject:/i) &&
        !lowerLine.match(/\d{5}/) && // Not a ZIP code
        !lowerLine.match(/\d+\s+[a-z\s]+(street|st|avenue|ave|road|rd|drive|dr|boulevard|blvd|way|place|pl|lane|ln)[\s,]/i); // Not an address
      
      if (looksLikeCompany) {
        result.company = line.trim();
        // Don't break - continue looking for title
      }
    }
  }

  return result;
}

const phoneRegex = /[\d\s().-]{10,}/; // Simple phone pattern for filtering

/**
 * Extract signature data from email body.
 * Returns null if no signature found, otherwise returns extracted data.
 */
export function extractSignatureData(
  bodyText: string,
  senderAddress: string
): ExtractedSignature | null {
  const signatureText = extractSignature(bodyText);
  if (!signatureText) return null;

  return parseSignatureBlock(signatureText, senderAddress);
}
