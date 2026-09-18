import { sanitizeCdpEvent } from "./sanitize.js"
import { buildComposerInspectionExpression } from "./composer-inspection.js"
import {
  buildComposerDraftClearExpression,
  buildComposerDraftCompareExpression,
  buildComposerDraftWriteExpression,
} from "./composer-draft.js"

const DEBUGGER_PROTOCOL_VERSION = "1.3"
const CHATGPT_ORIGIN = "https://chatgpt.com/"
const CHATGPT_PATTERN = "https://chatgpt.com/*"
const EVENT_METHODS = new Set([
  "Network.requestWillBeSent",
  "Network.responseReceived",
  "Network.webSocketCreated",
  "Network.webSocketFrameReceived",
  "Network.webSocketFrameSent",
  "Page.frameNavigated",
])

let pollGeneration = 0
const attachedTabs = new Set()

chrome.runtime.onInstalled.addListener(() => {
  chrome.runtime.openOptionsPage().catch(() => undefined)
})

chrome.action.onClicked.addListener(() => {
  chrome.runtime.openOptionsPage().catch(() => undefined)
})

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "config_updated") restartPolling()
})

chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId !== undefined) attachedTabs.delete(source.tabId)
})

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (source.tabId === undefined || !attachedTabs.has(source.tabId) || !EVENT_METHODS.has(method)) return
  void postEvent({
    type: "cdp_event",
    tab_id: source.tabId,
    method,
    params: sanitizeCdpEvent(method, params),
  })
})

restartPolling()

function restartPolling() {
  pollGeneration += 1
  const generation = pollGeneration
  void pollLoop(generation)
}

async function pollLoop(generation) {
  while (generation === pollGeneration) {
    const config = await getConfig()
    if (!config.enabled || !config.token) {
      await delay(1_000)
      continue
    }

    try {
      const response = await fetch(
        `${config.bridgeUrl}/extension/next?client_id=${encodeURIComponent(chrome.runtime.id)}`,
        {
          headers: authHeaders(config.token),
          cache: "no-store",
        }
      )

      if (response.status === 204) continue
      if (!response.ok) throw new Error(`bridge returned HTTP ${response.status}`)

      const command = await response.json()
      await executeAndReport(command, config)
    } catch (error) {
      await delay(1_500)
    }
  }
}

async function executeAndReport(command, config) {
  try {
    const result = await handleCommand(command)
    await fetch(`${config.bridgeUrl}/extension/result`, {
      method: "POST",
      headers: authHeaders(config.token, true),
      body: JSON.stringify({ id: command.id, ok: true, result }),
    })
  } catch (error) {
    await fetch(`${config.bridgeUrl}/extension/result`, {
      method: "POST",
      headers: authHeaders(config.token, true),
      body: JSON.stringify({
        id: command.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }),
    }).catch(() => undefined)
  }
}

async function handleCommand(command) {
  const payload = command?.payload ?? {}

  switch (command?.type) {
    case "ping":
      return {
        runtime_id: chrome.runtime.id,
        attached_tab_ids: [...attachedTabs],
      }

    case "list_tabs": {
      const tabs = await chrome.tabs.query({ url: CHATGPT_PATTERN })
      return { tabs: tabs.map(publicTab) }
    }

    case "get_tab": {
      const tab = await requireChatGptTab(payload.tab_id)
      return { tab: publicTab(tab) }
    }

    case "create_chatgpt_tab": {
      const url = payload.url ?? CHATGPT_ORIGIN
      assertChatGptUrl(url)
      const tab = await chrome.tabs.create({ url, active: false })
      if (tab.id === undefined) throw new Error("Chrome created a tab without an id.")
      const ready = await waitForTab(tab.id)
      return { tab: publicTab(ready) }
    }

    case "navigate": {
      const tab = await requireChatGptTab(payload.tab_id)
      const url = payload.url
      assertChatGptUrl(url)
      const updated = await chrome.tabs.update(tab.id, { url, active: false })
      const ready = await waitForTab(updated.id)
      return { tab: publicTab(ready) }
    }

    case "close_tab": {
      const tab = await requireChatGptTab(payload.tab_id)
      if (attachedTabs.has(tab.id)) {
        await chrome.debugger.detach({ tabId: tab.id }).catch(() => undefined)
        attachedTabs.delete(tab.id)
      }
      await chrome.tabs.remove(tab.id)
      return { closed_tab_id: tab.id }
    }

    case "attach": {
      const tab = await requireChatGptTab(payload.tab_id)
      if (!attachedTabs.has(tab.id)) {
        await chrome.debugger.attach({ tabId: tab.id }, DEBUGGER_PROTOCOL_VERSION)
        attachedTabs.add(tab.id)
      }
      await chrome.debugger.sendCommand({ tabId: tab.id }, "Network.enable")
      await chrome.debugger.sendCommand({ tabId: tab.id }, "Page.enable")
      await chrome.debugger.sendCommand({ tabId: tab.id }, "Runtime.enable")
      return { attached_tab_id: tab.id }
    }

    case "inspect_composer": {
      const tab = await requireChatGptTab(payload.tab_id)
      if (!attachedTabs.has(tab.id)) {
        throw new Error(`Tab ${tab.id} is not attached. Run attach first.`)
      }

      const evaluation = await chrome.debugger.sendCommand(
        { tabId: tab.id },
        "Runtime.evaluate",
        {
          expression: buildComposerInspectionExpression(),
          returnByValue: true,
          awaitPromise: false,
          userGesture: false,
        }
      )

      if (evaluation.exceptionDetails) {
        throw new Error("Composer inspection failed inside the page runtime.")
      }

      return {
        tab_id: tab.id,
        ...(evaluation.result?.value ?? {
          found: false,
          candidate_count: 0,
          candidates: [],
        }),
      }
    }

    case "write_composer_draft": {
      const tab = await requireChatGptTab(payload.tab_id)
      if (!attachedTabs.has(tab.id)) {
        throw new Error(`Tab ${tab.id} is not attached. Run attach first.`)
      }

      const text = payload.text
      const evaluation = await chrome.debugger.sendCommand(
        { tabId: tab.id },
        "Runtime.evaluate",
        {
          expression: buildComposerDraftWriteExpression(text),
          returnByValue: true,
          awaitPromise: false,
          userGesture: false,
        }
      )

      if (evaluation.exceptionDetails) {
        const message =
          evaluation.exceptionDetails.exception?.description ??
          evaluation.exceptionDetails.text ??
          "Composer draft write failed inside the page runtime."
        throw new Error(message)
      }

      return {
        tab_id: tab.id,
        ...(evaluation.result?.value ?? {
          verified: false,
          submitted: false,
        }),
      }
    }

    case "compare_composer_draft": {
      const tab = await requireChatGptTab(payload.tab_id)
      if (!attachedTabs.has(tab.id)) {
        throw new Error(`Tab ${tab.id} is not attached. Run attach first.`)
      }

      const evaluation = await chrome.debugger.sendCommand(
        { tabId: tab.id },
        "Runtime.evaluate",
        {
          expression: buildComposerDraftCompareExpression(payload.text),
          returnByValue: true,
          awaitPromise: false,
          userGesture: false,
        }
      )

      if (evaluation.exceptionDetails) {
        const message =
          evaluation.exceptionDetails.exception?.description ??
          evaluation.exceptionDetails.text ??
          "Composer draft comparison failed inside the page runtime."
        throw new Error(message)
      }

      return {
        tab_id: tab.id,
        ...(evaluation.result?.value ?? {
          exact_match: false,
          canonical_match: false,
          submitted: false,
        }),
      }
    }

    case "clear_composer_draft": {
      const tab = await requireChatGptTab(payload.tab_id)
      if (!attachedTabs.has(tab.id)) {
        throw new Error(`Tab ${tab.id} is not attached. Run attach first.`)
      }

      const evaluation = await chrome.debugger.sendCommand(
        { tabId: tab.id },
        "Runtime.evaluate",
        {
          expression: buildComposerDraftClearExpression(payload.text),
          returnByValue: true,
          awaitPromise: false,
          userGesture: false,
        }
      )

      if (evaluation.exceptionDetails) {
        const message =
          evaluation.exceptionDetails.exception?.description ??
          evaluation.exceptionDetails.text ??
          "Composer draft clear failed inside the page runtime."
        throw new Error(message)
      }

      return {
        tab_id: tab.id,
        ...(evaluation.result?.value ?? {
          verified: false,
          submitted: false,
        }),
      }
    }

    case "detach": {
      const tab = await requireChatGptTab(payload.tab_id)
      if (attachedTabs.has(tab.id)) {
        await chrome.debugger.detach({ tabId: tab.id })
        attachedTabs.delete(tab.id)
      }
      return { detached_tab_id: tab.id }
    }

    default:
      throw new Error(`Unsupported BEL-01 extension command: ${String(command?.type)}`)
  }
}

async function requireChatGptTab(tabId) {
  if (!Number.isInteger(tabId)) throw new Error("tab_id must be an integer.")
  const tab = await chrome.tabs.get(tabId)
  if (!tab.url || !isChatGptUrl(tab.url)) throw new Error(`Tab ${tabId} is not a ChatGPT tab.`)
  return tab
}

function assertChatGptUrl(value) {
  if (typeof value !== "string" || !isChatGptUrl(value)) {
    throw new Error("BEL-01 extension navigation is restricted to https://chatgpt.com/.")
  }
}

function isChatGptUrl(value) {
  try {
    const url = new URL(value)
    return url.protocol === "https:" && url.hostname === "chatgpt.com"
  } catch {
    return false
  }
}

function publicTab(tab) {
  return {
    id: tab.id,
    url: tab.url,
    title: tab.title,
    status: tab.status,
    active: tab.active,
    window_id: tab.windowId,
  }
}

async function waitForTab(tabId) {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    const tab = await chrome.tabs.get(tabId)
    if (tab.status === "complete" && tab.url && isChatGptUrl(tab.url)) return tab
    await delay(100)
  }
  throw new Error(`Timed out waiting for ChatGPT tab ${tabId}.`)
}

async function postEvent(event) {
  const config = await getConfig()
  if (!config.enabled || !config.token) return

  await fetch(`${config.bridgeUrl}/extension/event`, {
    method: "POST",
    headers: authHeaders(config.token, true),
    body: JSON.stringify(event),
  }).catch(() => undefined)
}


async function getConfig() {
  const value = await chrome.storage.local.get({
    bridgeUrl: "http://127.0.0.1:9233",
    token: "",
    enabled: false,
  })
  return {
    bridgeUrl: value.bridgeUrl.replace(/\/$/, ""),
    token: value.token,
    enabled: value.enabled === true,
  }
}

function authHeaders(token, json = false) {
  return {
    Authorization: `Bearer ${token}`,
    ...(json ? { "Content-Type": "application/json" } : {}),
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
