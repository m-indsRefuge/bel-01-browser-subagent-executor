export const MAX_RESPONSE_CHARACTERS: number
export const RESPONSE_CAPTURE_TIMEOUT_MS: number
export const RESPONSE_POLL_INTERVAL_MS: number
export const RESPONSE_POLL_MAX_WAIT_MS: number

export function validateResponseWaitMs(value: unknown): number

export function isConversationPayloadUrl(
  value: unknown,
  conversationId: string
): boolean

export function analyzeConversationPayload(
  payload: unknown,
  conversationId: string,
  expectedPrompt: string,
  maxResponseCharacters?: number
): {
  status: string
  conversation_id: string
  reason?: string
  user_turn_count?: number
  assistant_status?: string
  response?: string
  response_characters?: number
  response_total_characters?: number
  response_truncated?: boolean
}
