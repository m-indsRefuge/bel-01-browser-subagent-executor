export const SUBMISSION_BIND_TIMEOUT_MS: number
export const SUBMISSION_LEDGER_PREFIX: string
export const SEND_BUTTON_SELECTORS: readonly string[]

export function validateSubmissionId(value: unknown): string

export function submissionStorageKey(submissionId: string): string

export function buildSubmitButtonProbeExpression(): string

export function extractConversationBinding(
  value: string
): { conversation_id: string; conversation_url: string } | undefined
