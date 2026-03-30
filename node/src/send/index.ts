export { resolveSmtpSettings, type ResolvedSmtp, type SmtpOverrides } from "./smtp-resolve";
export {
  DEV_SEND_ALLOWLIST,
  assertSendRecipientsAllowed,
  extractEmailAddress,
} from "./recipients";
export { createSmtpTransport, verifySmtpConnection } from "./transport";
export { sendSimpleMessage, sendRawRfc822, sendDraftById, type SendSimpleFields, type SendResult } from "./send-mail";
export {
  readDraft,
  writeDraft,
  listDrafts,
  createDraftId,
  normalizeDraftFilename,
  subjectToSlug,
  generateDraftSuffix8,
  DRAFT_SUBJECT_SLUG_MAX,
  archiveDraftToSent,
  draftsDir,
  sentDir,
  serializeDraftMarkdown,
  draftRecordToJsonObject,
  draftBodyPreview,
  DRAFT_LIST_BODY_PREVIEW_LEN,
  type DraftRecord,
  type DraftFrontmatter,
  type DraftKind,
  type DraftListRow,
} from "./draft-store";
export { loadThreadingFromSourceMessage, normalizeMessageId } from "./threading";
export {
  loadForwardSourceExcerpt,
  composeForwardDraftBody,
  type ForwardSourceExcerpt,
} from "./load-message-body";
export { draftMarkdownToPlainText } from "./draft-body-plain";
export {
  rewriteDraftWithInstruction,
  type RewriteDraftResult,
  type RewriteDraftWithInstructionOptions,
  type RewriteDraftLlmComplete,
} from "./draft-rewrite";
export {
  composeNewDraftFromInstruction,
  type ComposeNewDraftResult,
  type ComposeNewDraftFromInstructionOptions,
  type ComposeNewDraftLlmComplete,
} from "./compose-new-draft";
export { buildDraftListJsonPayload, draftListSlimHint } from "./draft-list-json";
