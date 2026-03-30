import TurndownService from "turndown";

const turndown = new TurndownService({
  codeBlockStyle: "fenced",
  headingStyle: "atx",
  bulletListMarker: "-",
  emDelimiter: "*",
  strongDelimiter: "**",
});
turndown.addRule("dropImagesKeepAltText", {
  filter: "img",
  replacement: (_content, node) => {
    const alt = "getAttribute" in node ? (node.getAttribute("alt") ?? "").trim() : "";
    return alt ? ` ${alt} ` : " ";
  },
});

function collapseBlankLines(lines: string[]): string[] {
  const out: string[] = [];
  let blankRun = 0;
  for (const line of lines) {
    if (line.trim() === "") {
      blankRun += 1;
      if (blankRun <= 1) out.push("");
      continue;
    }
    blankRun = 0;
    out.push(line);
  }
  while (out.length > 0 && out[out.length - 1] === "") out.pop();
  return out;
}

export function normalizePlainTextToMarkdown(text: string): string {
  const unified = text.replace(/\r\n?/g, "\n").replace(/\u00a0/g, " ");
  const lines = unified
    .split("\n")
    .map((line) =>
      line
        .replace(/\t/g, "  ")
        .replace(/^-\s+/, "- ")
        .replace(/^(\d+\.)\s+/, "$1 ")
        .replace(/[ \t]+$/g, "")
    );
  return collapseBlankLines(lines).join("\n").trim();
}

export function htmlToMarkdown(html: string): string {
  const sanitized = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "");
  const markdown = turndown.turndown(sanitized);
  return normalizePlainTextToMarkdown(markdown);
}

