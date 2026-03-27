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
  archiveDraftToSent,
  draftsDir,
  sentDir,
  serializeDraftMarkdown,
  type DraftRecord,
  type DraftFrontmatter,
  type DraftKind,
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
