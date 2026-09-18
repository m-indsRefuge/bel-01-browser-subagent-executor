import type { ChatGptSubagentActivity } from "./chatgpt-subagent-contracts.js"
import type { AssistantResponseObservation } from "./chatgpt-subagent-observer.js"

export interface ChatGptManagedPage {
  readonly id: string
  url(): string
  isClosed(): boolean
}

export interface ChatGptTurnObservationInput {
  prompt: string
  onActivity?: (activity?: ChatGptSubagentActivity) => void
  onConversationId?: (conversationId: string) => void
}

export interface ChatGptSubmitTurnInput {
  turnId: string
  prompt: string
  expectedConversationId?: string
}

export interface ChatGptSubagentTransport {
  readonly kind: "cdp" | "extension"

  ensureConnected(signal?: AbortSignal): Promise<void>
  createPage(signal?: AbortSignal): Promise<ChatGptManagedPage>
  navigate(page: ChatGptManagedPage, url: string, signal?: AbortSignal): Promise<void>
  ensureReady(page: ChatGptManagedPage, signal?: AbortSignal): Promise<void>
  observeAssistantResponse(
    page: ChatGptManagedPage,
    input: ChatGptTurnObservationInput
  ): Promise<AssistantResponseObservation>
  enterPrompt(page: ChatGptManagedPage, prompt: string, signal?: AbortSignal): Promise<void>
  submitTurn(page: ChatGptManagedPage, input: ChatGptSubmitTurnInput, signal?: AbortSignal): Promise<void>
  detectRateLimit(signal?: AbortSignal): Promise<boolean>
  dismissRateLimit(signal?: AbortSignal): Promise<void>
  closePage(page: ChatGptManagedPage): Promise<void>
  dispose(): Promise<void>

  forkLatestPage?(page: ChatGptManagedPage, signal?: AbortSignal): Promise<ChatGptManagedPage>
  recoverSubmittedTurn?(
    page: ChatGptManagedPage | undefined,
    conversationUrl: string,
    prompt: string,
    expectedUserTurnCount: number
  ): Promise<{ response?: string; page?: ChatGptManagedPage }>
}
