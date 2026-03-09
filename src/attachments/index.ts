// DocumentExtractor interface — ADR-012
// Each format gets its own implementation behind this interface.

import { existsSync, readFileSync } from "fs";
import pdfParse from "@cedrugs/pdf-parse";
import mammoth from "mammoth";
import ExcelJS from "exceljs";
import TurndownService from "turndown";
import { getDb } from "~/db";
import { config } from "~/lib/config";

export interface ExtractedDocument {
  text: string;
  mimeType: string;
  filename: string;
}

export interface DocumentExtractor {
  canHandle(mimeType: string, filename: string): boolean;
  extract(buffer: Buffer, filename: string): Promise<ExtractedDocument>;
}

// PDF extractor
class PdfExtractor implements DocumentExtractor {
  canHandle(mimeType: string, _filename: string): boolean {
    return mimeType === "application/pdf";
  }

  async extract(buffer: Buffer, filename: string): Promise<ExtractedDocument> {
    const data = await pdfParse(buffer);
    return {
      text: data.text || "",
      mimeType: "application/pdf",
      filename,
    };
  }
}

// DOCX extractor (to markdown)
class DocxExtractor implements DocumentExtractor {
  canHandle(mimeType: string, filename: string): boolean {
    return (
      mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
      filename.toLowerCase().endsWith(".docx")
    );
  }

  async extract(buffer: Buffer, filename: string): Promise<ExtractedDocument> {
    const result = await (mammoth as any).convertToMarkdown({ buffer });
    return {
      text: result.value || "",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      filename,
    };
  }
}

/** Recursively reduce a cell value to a primitive or Date for CSV output. Handles formula objects, rich text, and nested shapes. */
function cellValueToPrimitive(value: unknown, cell: { text?: string }): unknown {
  if (value === null || value === undefined) return value;
  if (value instanceof Date) return value;
  if (typeof value !== "object") return value;

  const o = value as Record<string, unknown>;
  // Prefer formatted display: w, then result, then value, then v
  const next =
    o.w !== null && o.w !== undefined && o.w !== ""
      ? o.w
      : o.result !== null && o.result !== undefined
        ? o.result
        : o.value !== null && o.value !== undefined
          ? o.value
          : o.v !== null && o.v !== undefined
            ? o.v
            : undefined;
  if (next !== undefined) {
    const resolved = cellValueToPrimitive(next, cell);
    if (resolved !== null && resolved !== undefined && typeof resolved !== "object") return resolved;
    if (resolved instanceof Date) return resolved;
  }
  // Rich text: array of runs with .text
  if (Array.isArray(o.richText) && o.richText.length > 0) {
    const parts = (o.richText as Array<{ text?: string }>).map((r) => r.text ?? "").filter(Boolean);
    if (parts.length > 0) return parts.join("");
  }
  if (typeof o.text === "string" && o.text !== "") return o.text;
  if (typeof o.error === "string") return o.error;
  // Ultimate fallback: ExcelJS display string for this cell
  return cell.text ?? "";
}

// XLSX/XLS extractor (to CSV)
class XlsxExtractor implements DocumentExtractor {
  canHandle(mimeType: string, filename: string): boolean {
    return (
      mimeType === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
      mimeType === "application/vnd.ms-excel" ||
      filename.toLowerCase().endsWith(".xlsx") ||
      filename.toLowerCase().endsWith(".xls")
    );
  }

  async extract(buffer: Buffer, filename: string): Promise<ExtractedDocument> {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as any);

    const sheets: string[] = [];
    for (const worksheet of workbook.worksheets) {
      const rows: string[] = [];
      worksheet.eachRow((row) => {
        // Use eachCell to access cells directly, which properly handles formula cells
        // Build an array of cell values, handling empty cells to maintain column alignment
        const maxCol = row.cellCount;
        const cellValues: string[] = [];
        
        // Process each cell in the row
        row.eachCell({ includeEmpty: false }, (cell, colNumber) => {
          // Get the cell value - for formulas, ExcelJS may return an object (e.g. {formula, result} or {v, w})
          let value: unknown = cell.value;
          value = cellValueToPrimitive(value, cell as { text?: string });
          // Convert to string representation
          let str: string;
          if (value === null || value === undefined) {
            str = "";
          } else if (value instanceof Date) {
            str = value.toISOString().split("T")[0];
          } else {
            str = String(value);
          }
          
          // Quote fields containing commas, quotes, or newlines
          if (str.includes(",") || str.includes('"') || str.includes("\n")) {
            str = `"${str.replace(/"/g, '""')}"`;
          }
          
          // Store at correct column position (colNumber is 1-indexed)
          cellValues[colNumber - 1] = str;
        });
        
        // Build the row string, filling empty cells with empty strings
        const rowCells: string[] = [];
        for (let i = 0; i < maxCol; i++) {
          rowCells.push(cellValues[i] || "");
        }
        
        rows.push(rowCells.join(","));
      });

      if (workbook.worksheets.length > 1) {
        sheets.push(`## Sheet: ${worksheet.name}\n\n${rows.join("\n")}`);
      } else {
        sheets.push(rows.join("\n"));
      }
    }

    return {
      text: sheets.join("\n\n"),
      mimeType: "text/csv",
      filename,
    };
  }
}

// CSV extractor (passthrough)
class CsvExtractor implements DocumentExtractor {
  canHandle(mimeType: string, filename: string): boolean {
    return mimeType === "text/csv" || filename.toLowerCase().endsWith(".csv");
  }

  async extract(buffer: Buffer, filename: string): Promise<ExtractedDocument> {
    return {
      text: buffer.toString("utf8"),
      mimeType: "text/csv",
      filename,
    };
  }
}

// HTML extractor (to markdown)
class HtmlExtractor implements DocumentExtractor {
  private turndown: TurndownService;

  constructor() {
    this.turndown = new TurndownService();
  }

  canHandle(mimeType: string, filename: string): boolean {
    return mimeType === "text/html" || filename.toLowerCase().endsWith(".html") || filename.toLowerCase().endsWith(".htm");
  }

  async extract(buffer: Buffer, filename: string): Promise<ExtractedDocument> {
    const html = buffer.toString("utf8");
    const markdown = this.turndown.turndown(html);
    return {
      text: markdown,
      mimeType: "text/markdown",
      filename,
    };
  }
}

// Plain text extractor (passthrough)
class TextExtractor implements DocumentExtractor {
  canHandle(mimeType: string, filename: string): boolean {
    return mimeType === "text/plain" || filename.toLowerCase().endsWith(".txt");
  }

  async extract(buffer: Buffer, filename: string): Promise<ExtractedDocument> {
    return {
      text: buffer.toString("utf8"),
      mimeType: "text/plain",
      filename,
    };
  }
}

// Registry of extractors (order matters - more specific first)
const extractors: DocumentExtractor[] = [
  new PdfExtractor(),
  new DocxExtractor(),
  new XlsxExtractor(),
  new CsvExtractor(),
  new HtmlExtractor(),
  new TextExtractor(),
];

/**
 * Determines the output format and file extension for a given mime type and filename.
 * Returns the extension (including the dot) for the converted file.
 */
function getOutputExtension(mimeType: string, filename: string): string {
  // Spreadsheets → CSV
  if (
    mimeType === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
    mimeType === "application/vnd.ms-excel" ||
    filename.toLowerCase().endsWith(".xlsx") ||
    filename.toLowerCase().endsWith(".xls")
  ) {
    return ".csv";
  }
  // CSV → CSV (passthrough)
  if (mimeType === "text/csv" || filename.toLowerCase().endsWith(".csv")) {
    return ".csv";
  }
  // Everything else → markdown
  return ".md";
}

/**
 * Extracts text from an attachment.
 * Returns the extracted text. Does NOT cache to sibling files yet (pending accuracy validation).
 * @param skipCache If true, clear cached extracted_text and re-extract from the raw file.
 */
export async function extractAndCache(
  rawPath: string, // absolute path to raw file
  mimeType: string,
  filename: string,
  attachmentId: number,
  skipCache = false
): Promise<{ text: string; convertedPath: string }> {
  const outputExt = getOutputExtension(mimeType, filename);
  const convertedPath = rawPath + outputExt; // For reference only, not written yet

  const db = getDb();
  const useCache = config.attachments.cacheExtractedText && !skipCache;
  if (skipCache) {
    db.prepare("UPDATE attachments SET extracted_text = NULL WHERE id = ?").run(attachmentId);
  } else if (useCache) {
    // Use cached extracted text only when config enables it
    const existing = db.prepare("SELECT extracted_text FROM attachments WHERE id = ?").get(attachmentId) as
      | { extracted_text: string | null }
      | undefined;
    if (existing && existing.extracted_text) {
      return { text: existing.extracted_text, convertedPath };
    }
  }

  // Find appropriate extractor
  const extractor = extractors.find((e) => e.canHandle(mimeType, filename));
  if (!extractor) {
    // Unsupported format - return stub message
    const sizeMB = (existsSync(rawPath) ? readFileSync(rawPath).length : 0) / (1024 * 1024);
    const stubText = `[Binary attachment: ${filename}, ${sizeMB.toFixed(2)} MB — no text extraction available]`;
    // Update DB with stub
    db.prepare("UPDATE attachments SET extracted_text = ? WHERE id = ?").run(stubText, attachmentId);
    return { text: stubText, convertedPath };
  }

  // Read raw file and extract
  const rawBuffer = readFileSync(rawPath);
  const extracted = await extractor.extract(rawBuffer, filename);

  // Update DB (but don't write sibling file yet - pending accuracy validation)
  db.prepare("UPDATE attachments SET extracted_text = ? WHERE id = ?").run(extracted.text, attachmentId);

  return { text: extracted.text, convertedPath };
}

/**
 * Legacy function for backwards compatibility.
 * Routes to the appropriate extractor based on mime type and filename.
 */
export async function extractAttachment(
  buffer: Buffer,
  mimeType: string,
  filename: string
): Promise<string | null> {
  const extractor = extractors.find((e) => e.canHandle(mimeType, filename));
  if (!extractor) {
    return null;
  }

  try {
    const result = await extractor.extract(buffer, filename);
    return result.text;
  } catch (err) {
    return null;
  }
}
