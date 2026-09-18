import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { join } from "node:path"

import { MCP_CONFIG } from "../../config.js"
import { ChatGptSubagentError } from "./chatgpt-subagent-contracts.js"

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url))
const tokenPath = join(repoRoot, ".shellby", "chrome-extension-bridge.token")
const DEFAULT_COMMAND_WAIT_MS = 60_000
const DEFAULT_EVENT_WAIT_MS = 20_000
const RESULT_POLL_MS = 200

export interface ExtensionBridgeEvent {
  sequence: number
  type?: string
  observation_id?: string
  tab_id?: number
  kind?: string
  data?: string
  received_at?: string
  [key: string]: unknown
}

interface ExtensionCommandResult<T> {
  id: string
  ok: boolean
  result?: T
  error?: string
  received_at?: string
}

export class ExtensionBridgeClient {
  private constructor(
    private readonly baseUrl: string,
    private readonly token: string
  ) {}

  static async create(): Promise<ExtensionBridgeClient> {
    const baseUrl = process.env.BEL01_BRIDGE_URL ?? MCP_CONFIG.chatGpt.extensionBridgeUrl
    const token = (
      process.env.BEL01_BRIDGE_TOKEN ??
      (await readFile(tokenPath, "utf8").catch(() => ""))
    ).trim()

    if (!token) {
      throw new ChatGptSubagentError(
        "BROWSER_UNAVAILABLE",
        `BEL-01 extension bridge token is missing at ${tokenPath}. Start the extension bridge first.`
      )
    }

    return new ExtensionBridgeClient(baseUrl.replace(/\/$/, ""), token)
  }

  async health(): Promise<Record<string, unknown>> {
    const response = await fetch(`${this.baseUrl}/health`, { cache: "no-store" })
    if (!response.ok) {
      throw new ChatGptSubagentError(
        "BROWSER_UNAVAILABLE",
        `BEL-01 extension bridge health returned HTTP ${response.status}.`
      )
    }
    return (await response.json()) as Record<string, unknown>
  }

  async command<T>(
    type: string,
    payload: Record<string, unknown> = {},
    waitMs = DEFAULT_COMMAND_WAIT_MS
  ): Promise<T> {
    const created = await this.requestJson<{ id: string }>("/operator/command", {
      method: "POST",
      body: JSON.stringify({ type, payload }),
    })

    const deadline = Date.now() + waitMs
    while (Date.now() < deadline) {
      await delay(RESULT_POLL_MS)
      const response = await fetch(
        `${this.baseUrl}/operator/result/${encodeURIComponent(created.id)}`,
        { headers: this.authHeaders() }
      )
      if (response.status === 202) continue
      if (!response.ok) {
        throw new Error(
          `BEL-01 extension result returned HTTP ${response.status}: ${await response.text()}`
        )
      }

      const result = (await response.json()) as ExtensionCommandResult<T>
      if (!result.ok) {
        throw new Error(result.error ?? `BEL-01 extension command ${type} failed.`)
      }
      return result.result as T
    }

    throw new Error(
      `Timed out waiting for BEL-01 extension command ${created.id} (${type}) after ${waitMs} ms.`
    )
  }

  async eventCursor(): Promise<number> {
    const batch = await this.eventsAfter(0, 0)
    return batch.nextSequence
  }

  async eventsAfter(
    after: number,
    waitMs = DEFAULT_EVENT_WAIT_MS
  ): Promise<{
    events: ExtensionBridgeEvent[]
    nextSequence: number
    oldestSequence: number
  }> {
    const params = new URLSearchParams({
      after: String(Math.max(0, after)),
      wait_ms: String(Math.max(0, Math.min(waitMs, 30_000))),
    })
    const value = await this.requestJson<{
      events?: unknown
      next_sequence?: unknown
      oldest_sequence?: unknown
    }>(`/operator/events?${params.toString()}`)

    const events = Array.isArray(value.events)
      ? value.events.filter(isBridgeEvent)
      : []
    return {
      events,
      nextSequence:
        typeof value.next_sequence === "number" ? value.next_sequence : after,
      oldestSequence:
        typeof value.oldest_sequence === "number" ? value.oldest_sequence : after,
    }
  }

  private async requestJson<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        ...this.authHeaders(),
        "Content-Type": "application/json",
        ...(init.headers ?? {}),
      },
    })
    if (!response.ok) {
      throw new Error(
        `BEL-01 extension bridge returned HTTP ${response.status}: ${await response.text()}`
      )
    }
    return (await response.json()) as T
  }

  private authHeaders(): Record<string, string> {
    return { Authorization: `Bearer ${this.token}` }
  }
}

function isBridgeEvent(value: unknown): value is ExtensionBridgeEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const event = value as Record<string, unknown>
  return typeof event.sequence === "number"
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
