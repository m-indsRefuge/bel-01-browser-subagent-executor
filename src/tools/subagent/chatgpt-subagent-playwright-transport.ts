import type { Browser, BrowserContext, Page } from "playwright-core"

import { MCP_CONFIG } from "../../config.js"
import {
  assertAuthenticated,
  createBackgroundPage,
  enterPrompt,
  extractConversationId,
  findComposer,
  forkLatestConversationTurn,
  isChatGptUrl,
  navigateAndCaptureConversationPayload,
  navigateChatGptPage,
  submitComposer,
  throwIfAborted,
} from "./chatgpt-subagent-browser.js"
import { observeAssistantResponse } from "./chatgpt-subagent-observer.js"
import { ChatGptSubagentError } from "./chatgpt-subagent-contracts.js"
import {
  extractConversationMessages,
  findLatestAssistantAfterPrompt,
} from "./chatgpt-subagent-protocol.js"
import type {
  ChatGptManagedPage,
  ChatGptSubagentTransport,
  ChatGptSubmitTurnInput,
  ChatGptTurnObservationInput,
} from "./chatgpt-subagent-transport.js"

const CONNECT_TIMEOUT_MS = 3_000
const RATE_LIMIT_SELECTOR = '[data-testid="modal-conversation-history-rate-limit"]'

class PlaywrightManagedPage implements ChatGptManagedPage {
  constructor(
    readonly id: string,
    readonly native: Page
  ) {}

  url(): string {
    return this.native.url()
  }

  isClosed(): boolean {
    return this.native.isClosed()
  }
}

export function createPlaywrightSubagentTransport(): ChatGptSubagentTransport {
  let browser: Browser | undefined
  let context: BrowserContext | undefined
  let connectPromise: Promise<void> | undefined
  let pageCounter = 0

  const unwrap = (page: ChatGptManagedPage): PlaywrightManagedPage => {
    if (!(page instanceof PlaywrightManagedPage)) {
      throw new ChatGptSubagentError("AGENT_TARGET_LOST", "Managed page does not belong to the CDP transport.")
    }
    return page
  }

  const wrap = (page: Page): PlaywrightManagedPage =>
    new PlaywrightManagedPage(`cdp-page-${++pageCounter}`, page)

  const ensureConnected = async (signal?: AbortSignal): Promise<void> => {
    throwIfAborted(signal)
    if (browser?.isConnected() && context) return

    connectPromise ??= (async () => {
      try {
        const { chromium } = await import("playwright-core")
        browser = await chromium.connectOverCDP(MCP_CONFIG.chatGpt.cdpEndpoint, {
          timeout: CONNECT_TIMEOUT_MS,
        })
      } catch (error) {
        throw new ChatGptSubagentError(
          "BROWSER_UNAVAILABLE",
          [
            "ChatGPT agent browser is unavailable.",
            `Expected an already-running debuggable Chrome instance at ${MCP_CONFIG.chatGpt.cdpEndpoint}.`,
            "This module is attach-only and will not launch Chrome or choose a Chrome profile.",
          ].join(" "),
          { cause: error }
        )
      }

      const [browserContext] = browser.contexts()
      if (!browserContext) {
        throw new ChatGptSubagentError(
          "BROWSER_UNAVAILABLE",
          "Connected Chrome instance did not expose a browser context."
        )
      }
      context = browserContext
    })().finally(() => {
      connectPromise = undefined
    })

    await connectPromise
    throwIfAborted(signal)
  }

  return {
    kind: "cdp",

    ensureConnected,

    async createPage(signal) {
      await ensureConnected(signal)
      if (!browser || !context) {
        throw new ChatGptSubagentError("BROWSER_UNAVAILABLE", "ChatGPT browser is not connected.")
      }
      return wrap(await createBackgroundPage(browser, context))
    },

    async navigate(page, url, signal) {
      await navigateChatGptPage(unwrap(page).native, url, signal)
    },

    async ensureReady(page, signal) {
      const native = unwrap(page).native
      await assertAuthenticated(native)
      await findComposer(native, signal)
    },

    async observeAssistantResponse(page, input: ChatGptTurnObservationInput) {
      return observeAssistantResponse(unwrap(page).native, input)
    },

    async enterPrompt(page, prompt, signal) {
      const native = unwrap(page).native
      const composer = await findComposer(native, signal)
      await enterPrompt(native, composer, prompt, signal)
    },

    async submitTurn(page, _input: ChatGptSubmitTurnInput, signal) {
      const native = unwrap(page).native
      const composer = await findComposer(native, signal)
      await submitComposer(native, composer, signal)
    },

    async detectRateLimit() {
      if (!context) return false
      for (const page of context.pages()) {
        if (!isChatGptUrl(page.url())) continue
        if (
          await page
            .locator(RATE_LIMIT_SELECTOR)
            .first()
            .isVisible()
            .catch(() => false)
        ) {
          return true
        }
      }
      return false
    },

    async dismissRateLimit(signal) {
      if (!context) return
      for (const page of context.pages()) {
        if (!isChatGptUrl(page.url())) continue
        const modal = page.locator(RATE_LIMIT_SELECTOR).first()
        if (!(await modal.isVisible().catch(() => false))) continue
        const button = modal.getByRole("button", { name: /got it|okay|ok|close/i }).first()
        await button.click().catch(() => page.keyboard.press("Escape"))
        throwIfAborted(signal)
      }
    },

    async closePage(page) {
      const managed = unwrap(page)
      if (!managed.native.isClosed()) await managed.native.close().catch(() => undefined)
    },

    async forkLatestPage(page, signal) {
      const managed = unwrap(page)
      const forked = await forkLatestConversationTurn(managed.native, signal)
      return forked === managed.native ? managed : wrap(forked)
    },

    async recoverSubmittedTurn(page, conversationUrl, prompt, expectedUserTurnCount) {
      const conversationId = extractConversationId(conversationUrl)
      if (!conversationId) return {}

      const existing = page ? unwrap(page) : undefined
      if (
        existing &&
        !existing.native.isClosed() &&
        extractConversationId(existing.native.url()) === conversationId
      ) {
        const payload = await existing.native
          .evaluate(async (id) => {
            const response = await fetch(`/backend-api/conversations/${encodeURIComponent(id)}`)
            return response.ok ? response.json() : undefined
          }, conversationId)
          .catch(() => undefined)
        const answer = findLatestAssistantAfterPrompt(
          extractConversationMessages(payload),
          prompt,
          expectedUserTurnCount
        )
        if (answer) return { response: answer.text, page: existing }
      }

      await ensureConnected()
      if (!browser || !context) return {}
      const replacement = wrap(await createBackgroundPage(browser, context))
      try {
        const payload = await navigateAndCaptureConversationPayload(replacement.native, conversationUrl)
        await assertAuthenticated(replacement.native)
        await findComposer(replacement.native)
        const answer = findLatestAssistantAfterPrompt(
          extractConversationMessages(payload),
          prompt,
          expectedUserTurnCount
        )
        return { response: answer?.text, page: replacement }
      } catch (error) {
        await replacement.native.close().catch(() => undefined)
        throw error
      }
    },

    async dispose() {
      const connectedBrowser = browser
      context = undefined
      browser = undefined
      connectPromise = undefined
      await connectedBrowser?.close().catch(() => undefined)
    },
  }
}
