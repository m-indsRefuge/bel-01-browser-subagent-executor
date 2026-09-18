import { randomUUID } from "node:crypto"

import { MCP_CONFIG } from "../../config.js"
import { ChatGptTurnTracker } from "./chatgpt-subagent-protocol.js"
import { ChatGptSubagentError } from "./chatgpt-subagent-contracts.js"
import type { AssistantResponseObservation } from "./chatgpt-subagent-observer.js"
import type {
  ChatGptManagedPage,
  ChatGptSubagentTransport,
  ChatGptSubmitTurnInput,
  ChatGptTurnObservationInput,
} from "./chatgpt-subagent-transport.js"
import {
  ExtensionBridgeClient,
  type ExtensionBridgeEvent,
} from "./extension-bridge-client.js"

const EVENT_WAIT_MS = 20_000

interface ExtensionTab {
  id?: number
  url?: string
  status?: string
}

class ExtensionManagedPage implements ChatGptManagedPage {
  private closed = false
  private currentUrl: string

  constructor(
    readonly tabId: number,
    url: string
  ) {
    this.currentUrl = url
  }

  get id(): string {
    return `extension-tab-${this.tabId}`
  }

  url(): string {
    return this.currentUrl
  }

  isClosed(): boolean {
    return this.closed
  }

  updateUrl(value?: string): void {
    if (typeof value === "string" && value.length > 0) this.currentUrl = value
  }

  markClosed(): void {
    this.closed = true
  }
}

export function createExtensionSubagentTransport(): ChatGptSubagentTransport {
  let clientPromise: Promise<ExtensionBridgeClient> | undefined
  const pages = new Map<number, ExtensionManagedPage>()

  const client = async (): Promise<ExtensionBridgeClient> => {
    clientPromise ??= ExtensionBridgeClient.create()
    return clientPromise
  }

  const unwrap = (page: ChatGptManagedPage): ExtensionManagedPage => {
    if (!(page instanceof ExtensionManagedPage)) {
      throw new ChatGptSubagentError(
        "AGENT_TARGET_LOST",
        "Managed page does not belong to the BEL-01 extension transport."
      )
    }
    return page
  }

  const refresh = async (page: ExtensionManagedPage): Promise<ExtensionManagedPage> => {
    const bridge = await client()
    const result = await bridge.command<{ tab?: ExtensionTab }>("get_tab", {
      tab_id: page.tabId,
    })
    if (!result.tab || result.tab.id !== page.tabId) {
      throw new ChatGptSubagentError(
        "AGENT_TARGET_LOST",
        `Extension child tab ${page.tabId} is unavailable.`
      )
    }
    page.updateUrl(result.tab.url)
    return page
  }

  const attach = async (page: ExtensionManagedPage): Promise<void> => {
    const bridge = await client()
    await bridge.command("attach", { tab_id: page.tabId })
  }

  return {
    kind: "extension",

    async ensureConnected(signal) {
      throwIfAborted(signal)
      const bridge = await client()
      const health = await bridge.health()
      if (health.extension_connected !== true) {
        throw new ChatGptSubagentError(
          "BROWSER_UNAVAILABLE",
          "BEL-01 extension bridge is running but the Chrome extension is not connected."
        )
      }
      throwIfAborted(signal)
    },

    async createPage(signal) {
      throwIfAborted(signal)
      const bridge = await client()
      const result = await bridge.command<{ tab?: ExtensionTab }>("create_chatgpt_tab")
      const tab = result.tab
      if (!tab || !Number.isInteger(tab.id) || typeof tab.url !== "string") {
        throw new ChatGptSubagentError(
          "BROWSER_UNAVAILABLE",
          "BEL-01 extension did not return a valid child tab."
        )
      }

      const page = new ExtensionManagedPage(tab.id as number, tab.url)
      pages.set(page.tabId, page)
      await attach(page)
      throwIfAborted(signal)
      return page
    },

    async navigate(page, url, signal) {
      throwIfAborted(signal)
      const managed = unwrap(page)
      const bridge = await client()
      const result = await bridge.command<{ tab?: ExtensionTab }>("navigate", {
        tab_id: managed.tabId,
        url,
      })
      managed.updateUrl(result.tab?.url)
      await attach(managed)
      throwIfAborted(signal)
    },

    async ensureReady(page, signal) {
      throwIfAborted(signal)
      const managed = unwrap(page)
      await refresh(managed)
      await attach(managed)
      const bridge = await client()
      const inspection = await bridge.command<{
        found?: boolean
        candidate_count?: number
      }>("inspect_composer", { tab_id: managed.tabId })

      if (inspection.found !== true || inspection.candidate_count !== 2) {
        if (inspection.found !== true) {
          throw new ChatGptSubagentError(
            "CHATGPT_UI_CHANGED",
            "BEL-01 extension could not identify the ChatGPT composer."
          )
        }
      }
      throwIfAborted(signal)
    },

    async observeAssistantResponse(page, input: ChatGptTurnObservationInput) {
      const managed = unwrap(page)
      const bridge = await client()
      const observationId = `obs-${randomUUID()}`
      let cursor = await bridge.eventCursor()
      await bridge.command("arm_turn_observer", {
        tab_id: managed.tabId,
        observation_id: observationId,
      })

      const webSocketTracker = new ChatGptTurnTracker(
        input.prompt,
        input.onActivity,
        (conversationId) => {
          managed.updateUrl(conversationUrl(conversationId))
          input.onConversationId?.(conversationId)
        }
      )
      const httpTracker = new ChatGptTurnTracker(
        input.prompt,
        input.onActivity,
        (conversationId) => {
          managed.updateUrl(conversationUrl(conversationId))
          input.onConversationId?.(conversationId)
        }
      )
      const buffers = new Map<string, string>()
      let settled = false
      let resolveResponse!: (value: { text: string; conversationId?: string; turnId?: string }) => void
      let rejectResponse!: (error: unknown) => void

      const response = new Promise<{ text: string; conversationId?: string; turnId?: string }>(
        (resolve, reject) => {
          resolveResponse = resolve
          rejectResponse = reject
        }
      )

      const disarm = async (): Promise<void> => {
        await bridge
          .command("disarm_turn_observer", {
            tab_id: managed.tabId,
            observation_id: observationId,
          })
          .catch(() => undefined)
      }

      const finish = (
        result:
          | { text: string; conversationId?: string; turnId?: string }
          | undefined
      ): boolean => {
        if (!result || settled) return false
        settled = true
        resolveResponse(result)
        void disarm()
        return true
      }

      const feedHttpChunk = (event: ExtensionBridgeEvent): boolean => {
        if (typeof event.data !== "string" || !event.data) return false
        const requestId =
          typeof event.request_id === "string" ? event.request_id : "default"
        let buffer = (buffers.get(requestId) ?? "") + event.data

        while (true) {
          const match = /\r?\n\r?\n/.exec(buffer)
          if (!match || match.index === undefined) break
          const end = match.index + match[0].length
          const block = buffer.slice(0, end)
          buffer = buffer.slice(end)
          if (finish(httpTracker.ingestSse(block))) return true
        }
        buffers.set(requestId, buffer)
        return false
      }

      const consume = (event: ExtensionBridgeEvent): boolean => {
        if (
          event.type !== "subagent_turn_stream" ||
          event.observation_id !== observationId ||
          event.tab_id !== managed.tabId
        ) {
          return false
        }

        if (event.kind === "ws_frame" && typeof event.data === "string") {
          try {
            return finish(webSocketTracker.ingestFrame(event.data))
          } catch {
            return false
          }
        }

        if (event.kind === "sse_chunk") {
          return feedHttpChunk(event)
        }

        if (event.kind === "sse_body" && typeof event.data === "string") {
          const fallback = new ChatGptTurnTracker(
            input.prompt,
            input.onActivity,
            input.onConversationId
          )
          return finish(fallback.ingestSse(event.data))
        }

        return false
      }

      void (async () => {
        try {
          while (!settled) {
            const batch = await bridge.eventsAfter(cursor, EVENT_WAIT_MS)
            if (
              batch.oldestSequence > cursor + 1 &&
              cursor > 0
            ) {
              throw new Error(
                "BEL-01 bridge event retention advanced past the active subagent observer cursor."
              )
            }
            cursor = batch.nextSequence
            for (const event of batch.events) {
              if (consume(event)) return
            }
          }
        } catch (error) {
          if (settled) return
          settled = true
          rejectResponse(error)
          await disarm()
        }
      })()

      return {
        response,
        async dispose() {
          if (!settled) {
            settled = true
            rejectResponse(
              new Error("BEL-01 extension subagent response observation was disposed.")
            )
          }
          await disarm()
        },
      } satisfies AssistantResponseObservation
    },

    async enterPrompt(page, prompt, signal) {
      throwIfAborted(signal)
      const managed = unwrap(page)
      const bridge = await client()
      await bridge.command("write_composer_draft", {
        tab_id: managed.tabId,
        text: prompt,
      })
      throwIfAborted(signal)
    },

    async submitTurn(page, input: ChatGptSubmitTurnInput, signal) {
      throwIfAborted(signal)
      const managed = unwrap(page)
      const bridge = await client()
      const result = await bridge.command<{
        conversation_id?: string
        conversation_url?: string
      }>("submit_agent_turn_once", {
        tab_id: managed.tabId,
        turn_id: input.turnId,
        text: input.prompt,
        ...(input.expectedConversationId
          ? { expected_conversation_id: input.expectedConversationId }
          : {}),
      })
      managed.updateUrl(result.conversation_url)
      throwIfAborted(signal)
    },

    async detectRateLimit() {
      return false
    },

    async dismissRateLimit() {},

    async closePage(page) {
      const managed = unwrap(page)
      if (managed.isClosed()) return
      const bridge = await client()
      await bridge
        .command("close_tab", { tab_id: managed.tabId })
        .catch(() => undefined)
      managed.markClosed()
      pages.delete(managed.tabId)
    },

    async dispose() {
      const openPages = [...pages.values()].filter((page) => !page.isClosed())
      await Promise.allSettled(
        openPages.map(async (page) => {
          const bridge = await client()
          await bridge.command("close_tab", { tab_id: page.tabId })
          page.markClosed()
        })
      )
      pages.clear()
    },
  }
}

function conversationUrl(conversationId: string): string {
  const url = new URL(MCP_CONFIG.chatGpt.projectUrl)
  const encodedId = encodeURIComponent(conversationId)
  if (/\/g\/g-p-[^/]+\/project\/?$/.test(url.pathname)) {
    url.pathname = `${url.pathname.replace(/\/project\/?$/, "")}/c/${encodedId}`
    url.search = ""
    url.hash = ""
    return url.toString()
  }
  return `https://chatgpt.com/c/${encodedId}`
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return
  throw new ChatGptSubagentError(
    "REQUEST_ABORTED",
    "The ChatGPT subagent request was cancelled. A submitted turn will not be retried automatically."
  )
}
