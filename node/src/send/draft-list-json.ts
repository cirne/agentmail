import {
  resolveSearchJsonFormat,
  type SearchResultFormatPreference,
} from "~/search/search-json-format";
import type { DraftListRow } from "./draft-store";

export function draftListSlimHint(): string {
  return (
    "Large draft list — slim rows (id, path, kind, subject). " +
    "Use zmail draft view <id>, read_file on path, or list with --result-format full for bodyPreview."
  );
}

function draftListRowToSlimJson(r: DraftListRow): Record<string, unknown> {
  const o: Record<string, unknown> = { id: r.id, path: r.path, kind: r.kind };
  if (r.subject != null && r.subject !== "") {
    o.subject = r.subject;
  }
  return o;
}

function draftListRowToFullJson(r: DraftListRow): Record<string, unknown> {
  return { ...draftListRowToSlimJson(r), bodyPreview: r.bodyPreview };
}

export function buildDraftListJsonPayload(
  rows: DraftListRow[],
  preference: SearchResultFormatPreference
): Record<string, unknown> {
  const format = resolveSearchJsonFormat({
    resultCount: rows.length,
    preference,
    allowAutoSlim: true,
  });
  const drafts =
    format === "slim" ? rows.map(draftListRowToSlimJson) : rows.map(draftListRowToFullJson);
  const out: Record<string, unknown> = {
    drafts,
    returned: drafts.length,
    format,
  };
  if (format === "slim") {
    out.hint = draftListSlimHint();
  }
  return out;
}
