export const MAX_RESPONSE_CHARACTERS: number
export const RESPONSE_POLL_INTERVAL_MS: number
export const RESPONSE_POLL_MAX_WAIT_MS: number

export function validateResponseWaitMs(value: unknown): number

export function buildConversationSnapshotExpression(
  conversationId: string,
  expectedPrompt: string,
  maxResponseCharacters?: number
): string
