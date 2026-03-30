#!/usr/bin/env node
/**
 * Test script for attachment extraction.
 * Usage: npx tsx tests/attachments/test-extract.ts <file-path>
 */

import { readFileSync } from "fs";
import { join } from "path";
import { extractAttachment } from "~/attachments";

const filePath = process.argv[2];

if (!filePath) {
  console.error("Usage: npx tsx tests/attachments/test-extract.ts <file-path>");
  process.exit(1);
}

// Determine mime type from extension
function getMimeType(filename: string): string {
  const ext = filename.toLowerCase().split(".").pop();
  const mimeTypes: Record<string, string> = {
    pdf: "application/pdf",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    xls: "application/vnd.ms-excel",
    csv: "text/csv",
    html: "text/html",
    htm: "text/html",
    txt: "text/plain",
  };
  return mimeTypes[ext || ""] || "application/octet-stream";
}

async function main() {
  try {
    const buffer = readFileSync(filePath);
    const filename = filePath.split("/").pop() || filePath;
    const mimeType = getMimeType(filename);

    console.log(`Extracting: ${filename}`);
    console.log(`MIME type: ${mimeType}`);
    console.log(`Size: ${buffer.length} bytes\n`);

    const result = await extractAttachment(buffer, mimeType, filename);

    if (result === null) {
      console.log("❌ Extraction failed or format not supported");
      process.exit(1);
    }

    console.log("✅ Extraction successful\n");
    console.log("--- Extracted Text ---");
    console.log(result);
    console.log("\n--- End ---");
  } catch (err) {
    console.error("Error:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

main();
