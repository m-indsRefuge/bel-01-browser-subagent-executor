import { sanitizeCdpEvent } from "./sanitize.js"
import { buildComposerInspectionExpression } from "./composer-inspection.js"
import {
  DRAFT_STABILIZATION_MS,
  buildComposerDraftCompareExpression,
  buildComposerDraftPrepareClearExpression,
  buildComposerDraftPrepareWriteExpression,
  validateComposerDraft,
} from "./composer-draft.js"
import {
  SUBMISSION_BIND_TIMEOUT_MS,
  buildSubmitButtonProbeExpression,
  extractConversationBinding,
  submissionStorageKey,
  validateSubmissionId,
} from "./submission.js"

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
const turnObservers = new Map()

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
  if (source.tabId === undefined) return
  attachedTabs.delete(source.tabId)
  turnObservers.delete(source.tabId)
})

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (source.tabId === undefined || !attachedTabs.has(source.tabId)) return

  if (turnObservers.has(source.tabId)) {
    void handleTurnObserverEvent(source.tabId, method, params)
  }

  if (!EVENT_METHODS.has(method)) return
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
    const expiresAt =
      typeof command?.expires_at === "string" ? Date.parse(command.expires_at) : Number.NaN
    if (Number.isFinite(expiresAt) && expiresAt <= Date.now()) {
      throw new Error("BEL-01 bridge command expired before execution; it was not executed.")
    }

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

    case "show_chatgpt_tab": {
      const tab = await requireChatGptTab(payload.tab_id)
      await chrome.tabs.update(tab.id, { active: true })
      await chrome.windows.update(tab.windowId, { focused: true })
      const shown = await chrome.tabs.get(tab.id)
      return {
        tab: publicTab(shown),
        focused_window_id: tab.windowId,
      }
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
      turnObservers.delete(tab.id)
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

    case "arm_turn_observer": {
      const tab = await requireChatGptTab(payload.tab_id)
      if (!attachedTabs.has(tab.id)) {
        throw new Error(`Tab ${tab.id} is not attached. Run attach first.`)
      }

      const observationId = validateObservationId(payload.observation_id)
      if (turnObservers.has(tab.id)) {
        throw new Error(`Tab ${tab.id} already has an armed turn observer.`)
      }

      turnObservers.set(tab.id, {
        observation_id: observationId,
        request_ids: new Set(),
      })
      return {
        tab_id: tab.id,
        observation_id: observationId,
        armed: true,
      }
    }

    case "disarm_turn_observer": {
      const tabId = payload.tab_id
      if (!Number.isInteger(tabId)) throw new Error("tab_id must be an integer.")
      const observationId = validateObservationId(payload.observation_id)
      const observer = turnObservers.get(tabId)
      if (observer?.observation_id === observationId) {
        turnObservers.delete(tabId)
      }
      return {
        tab_id: tabId,
        observation_id: observationId,
        armed: false,
      }
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

      const text = validateComposerDraft(payload.text)
      const preparation = await chrome.debugger.sendCommand(
        { tabId: tab.id },
        "Runtime.evaluate",
        {
          expression: buildComposerDraftPrepareWriteExpression(),
          returnByValue: true,
          awaitPromise: false,
          userGesture: false,
        }
      )

      if (preparation.exceptionDetails) {
        const message =
          preparation.exceptionDetails.exception?.description ??
          preparation.exceptionDetails.text ??
          "Composer draft preparation failed inside the page runtime."
        throw new Error(message)
      }

      const prepared = preparation.result?.value
      if (!prepared?.focused) {
        throw new Error("Composer draft preparation did not focus the target editor.")
      }

      await chrome.debugger.sendCommand(
        { tabId: tab.id },
        "Input.insertText",
        { text }
      )

      await delay(DRAFT_STABILIZATION_MS)

      const verification = await evaluateDraftComparison(tab.id, text)
      if (!verification.newline_normalized_match) {
        throw new Error(
          "Composer draft was not stable after React reconciliation. Do not retry automatically."
        )
      }

      return {
        tab_id: tab.id,
        mode: "write",
        selector_hint: verification.selector_hint ?? prepared.selector_hint,
        tag: verification.tag ?? prepared.tag,
        characters_written: text.length,
        composer_empty: false,
        verified: true,
        stable_after_ms: DRAFT_STABILIZATION_MS,
        submitted: false,
      }
    }

    case "compare_composer_draft": {
      const tab = await requireChatGptTab(payload.tab_id)
      if (!attachedTabs.has(tab.id)) {
        throw new Error(`Tab ${tab.id} is not attached. Run attach first.`)
      }

      const text = validateComposerDraft(payload.text)
      return {
        tab_id: tab.id,
        ...(await evaluateDraftComparison(tab.id, text)),
      }
    }

    case "clear_composer_draft": {
      const tab = await requireChatGptTab(payload.tab_id)
      if (!attachedTabs.has(tab.id)) {
        throw new Error(`Tab ${tab.id} is not attached. Run attach first.`)
      }

      const text = validateComposerDraft(payload.text)
      const before = await evaluateDraftComparison(tab.id, text)

      if (before.current_length === 0) {
        return {
          tab_id: tab.id,
          mode: "clear",
          characters_written: 0,
          composer_empty: true,
          already_empty: true,
          verified: true,
          stable_after_ms: 0,
          submitted: false,
        }
      }

      if (!before.newline_normalized_match) {
        throw new Error(
          "BEL-01B.1 refuses to clear composer content that does not exactly match the expected draft."
        )
      }

      const preparation = await chrome.debugger.sendCommand(
        { tabId: tab.id },
        "Runtime.evaluate",
        {
          expression: buildComposerDraftPrepareClearExpression(text),
          returnByValue: true,
          awaitPromise: false,
          userGesture: false,
        }
      )

      if (preparation.exceptionDetails) {
        const message =
          preparation.exceptionDetails.exception?.description ??
          preparation.exceptionDetails.text ??
          "Composer draft clear preparation failed inside the page runtime."
        throw new Error(message)
      }

      const prepared = preparation.result?.value
      if (!prepared?.focused) {
        throw new Error("Composer draft clear preparation did not focus the expected editor.")
      }

      const selectAllModifier = /Mac/i.test(navigator.platform) ? 4 : 2

      await chrome.debugger.sendCommand(
        { tabId: tab.id },
        "Input.dispatchKeyEvent",
        {
          type: "rawKeyDown",
          key: "a",
          code: "KeyA",
          modifiers: selectAllModifier,
          windowsVirtualKeyCode: 65,
          nativeVirtualKeyCode: 65,
        }
      )
      await chrome.debugger.sendCommand(
        { tabId: tab.id },
        "Input.dispatchKeyEvent",
        {
          type: "keyUp",
          key: "a",
          code: "KeyA",
          modifiers: selectAllModifier,
          windowsVirtualKeyCode: 65,
          nativeVirtualKeyCode: 65,
        }
      )
      await chrome.debugger.sendCommand(
        { tabId: tab.id },
        "Input.dispatchKeyEvent",
        {
          type: "rawKeyDown",
          key: "Backspace",
          code: "Backspace",
          windowsVirtualKeyCode: 8,
          nativeVirtualKeyCode: 8,
        }
      )
      await chrome.debugger.sendCommand(
        { tabId: tab.id },
        "Input.dispatchKeyEvent",
        {
          type: "keyUp",
          key: "Backspace",
          code: "Backspace",
          windowsVirtualKeyCode: 8,
          nativeVirtualKeyCode: 8,
        }
      )

      await delay(DRAFT_STABILIZATION_MS)

      const after = await evaluateDraftComparison(tab.id, text)
      if (after.current_length !== 0) {
        throw new Error(
          "Composer draft clear was not stable after React reconciliation. Do not retry automatically."
        )
      }

      return {
        tab_id: tab.id,
        mode: "clear",
        selector_hint: prepared.selector_hint,
        tag: prepared.tag,
        characters_written: 0,
        composer_empty: true,
        already_empty: false,
        verified: true,
        stable_after_ms: DRAFT_STABILIZATION_MS,
        submitted: false,
      }
    }

    case "submit_agent_turn_once": {
      const tab = await requireChatGptTab(payload.tab_id)
      if (!attachedTabs.has(tab.id)) {
        throw new Error(`Tab ${tab.id} is not attached. Run attach first.`)
      }

      const turnId = validateSubmissionId(payload.turn_id)
      const text = validateComposerDraft(payload.text)
      const promptSha256 = await sha256Hex(text)
      const expectedConversationId =
        typeof payload.expected_conversation_id === "string" &&
        payload.expected_conversation_id.length > 0
          ? payload.expected_conversation_id
          : undefined
      const existing = await loadAgentTurnReceipt(turnId)

      if (existing) {
        if (existing.tab_id !== tab.id || existing.prompt_sha256 !== promptSha256) {
          throw new Error(
            `turn_id ${turnId} is already bound to a different tab or prompt.`
          )
        }
        if (["bound", "armed", "uncertain"].includes(existing.status)) {
          return {
            ...publicAgentTurnReceipt(existing),
            no_resubmit: true,
          }
        }
        throw new Error(
          `turn_id ${turnId} has unsupported ledger status ${existing.status}; refusing duplicate submission.`
        )
      }

      const currentBinding = extractConversationBinding(tab.url)
      if (expectedConversationId) {
        if (!currentBinding || currentBinding.conversation_id !== expectedConversationId) {
          throw new Error(
            "The child tab is not bound to the expected conversation for this turn."
          )
        }
      } else if (currentBinding) {
        throw new Error(
          "A first agent turn requires an unbound ChatGPT child tab."
        )
      }

      const comparison = await evaluateDraftComparison(tab.id, text)
      if (!comparison.exact_match) {
        throw new Error(
          "Agent turn submission requires the composer to exactly match the expected prompt."
        )
      }

      const armed = {
        turn_id: turnId,
        status: "armed",
        tab_id: tab.id,
        prompt_sha256: promptSha256,
        expected_conversation_id: expectedConversationId,
        armed_at: new Date().toISOString(),
      }
      await saveAgentTurnReceipt(armed)

      let clickAttempted = false
      try {
        const evaluation = await chrome.debugger.sendCommand(
          { tabId: tab.id },
          "Runtime.evaluate",
          {
            expression: buildSubmitButtonProbeExpression(),
            returnByValue: true,
            awaitPromise: false,
            userGesture: true,
          }
        )

        if (evaluation.exceptionDetails) {
          const message =
            evaluation.exceptionDetails.exception?.description ??
            evaluation.exceptionDetails.text ??
            "Agent turn submission failed inside the page runtime."
          throw new Error(message)
        }

        const sendTarget = evaluation.result?.value
        if (
          !sendTarget?.click_ready ||
          !Number.isFinite(sendTarget.x) ||
          !Number.isFinite(sendTarget.y)
        ) {
          throw new Error("Agent turn did not receive a valid Send-button target.")
        }

        clickAttempted = true
        await chrome.debugger.sendCommand(
          { tabId: tab.id },
          "Input.dispatchMouseEvent",
          {
            type: "mousePressed",
            x: sendTarget.x,
            y: sendTarget.y,
            button: "left",
            clickCount: 1,
          }
        )
        await chrome.debugger.sendCommand(
          { tabId: tab.id },
          "Input.dispatchMouseEvent",
          {
            type: "mouseReleased",
            x: sendTarget.x,
            y: sendTarget.y,
            button: "left",
            clickCount: 1,
          }
        )

        let binding = currentBinding
        if (!binding) {
          binding = await waitForConversationBinding(tab.id, SUBMISSION_BIND_TIMEOUT_MS)
        }
        if (!binding) {
          throw new Error(
            "Agent turn may have been submitted, but conversation binding is uncertain. Do not retry."
          )
        }
        if (
          expectedConversationId &&
          binding.conversation_id !== expectedConversationId
        ) {
          throw new Error(
            "Agent turn bound to an unexpected conversation after submission."
          )
        }

        const bound = {
          ...armed,
          status: "bound",
          clicked_at: new Date().toISOString(),
          conversation_id: binding.conversation_id,
          conversation_url: binding.conversation_url,
          bound_at: new Date().toISOString(),
        }
        await saveAgentTurnReceipt(bound)
        return publicAgentTurnReceipt(bound)
      } catch (error) {
        const current = (await loadAgentTurnReceipt(turnId)) ?? armed
        if (!clickAttempted) throw error

        if (current.status === "bound") {
          return {
            ...publicAgentTurnReceipt(current),
            no_resubmit: true,
          }
        }

        const uncertain = {
          ...current,
          status: "uncertain",
          click_attempted: true,
          uncertain_at: current.uncertain_at ?? new Date().toISOString(),
          last_error: error instanceof Error ? error.message : String(error),
        }
        await saveAgentTurnReceipt(uncertain)
        return {
          ...publicAgentTurnReceipt(uncertain),
          no_resubmit: true,
        }
      }
    }

    case "submit_composer_once": {
      const submissionId = validateSubmissionId(payload.submission_id)
      const text = validateComposerDraft(payload.text)
      const promptSha256 = await sha256Hex(text)
      if (!Number.isInteger(payload.tab_id)) {
        throw new Error("tab_id must be an integer.")
      }
      const existing = await loadSubmissionReceipt(submissionId)

      if (existing) {
        if (existing.tab_id !== payload.tab_id || existing.prompt_sha256 !== promptSha256) {
          throw new Error(
            `submission_id ${submissionId} is already bound to a different tab or prompt.`
          )
        }
        if (existing.status === "bound") {
          return publicSubmissionReceipt(existing)
        }
        throw new Error(
          `submission_id ${submissionId} is already ${existing.status}; refusing duplicate submission. ` +
            "Use recover_prompt_submission instead."
        )
      }

      const tab = await requireChatGptTab(payload.tab_id)
      if (!attachedTabs.has(tab.id)) {
        throw new Error(`Tab ${tab.id} is not attached. Run attach first.`)
      }

      const tabReceipt = await findSubmissionReceiptByTab(tab.id)
      if (tabReceipt) {
        throw new Error(
          "This child tab is already tracked by submission_id " +
            tabReceipt.submission_id +
            " with status " +
            tabReceipt.status +
            "; BEL-01B.2a allows only one first-turn submission per tab."
        )
      }

      if (extractConversationBinding(tab.url)) {
        throw new Error("BEL-01B.2a requires a fresh ChatGPT child tab with no bound conversation.")
      }

      const comparison = await evaluateDraftComparison(tab.id, text)
      if (!comparison.exact_match) {
        throw new Error("BEL-01B.2a requires the composer to exactly match the expected prompt before submission.")
      }

      const armed = {
        submission_id: submissionId,
        status: "armed",
        tab_id: tab.id,
        prompt_sha256: promptSha256,
        armed_at: new Date().toISOString(),
      }
      await saveSubmissionReceipt(armed)

      let clickAttempted = false
      try {
        const evaluation = await chrome.debugger.sendCommand(
          { tabId: tab.id },
          "Runtime.evaluate",
          {
            expression: buildSubmitButtonProbeExpression(),
            returnByValue: true,
            awaitPromise: false,
            userGesture: true,
          }
        )

        if (evaluation.exceptionDetails) {
          const message =
            evaluation.exceptionDetails.exception?.description ??
            evaluation.exceptionDetails.text ??
            "Prompt submission failed inside the page runtime."
          throw new Error(message)
        }

        const sendTarget = evaluation.result?.value
        if (
          !sendTarget?.click_ready ||
          !Number.isFinite(sendTarget.x) ||
          !Number.isFinite(sendTarget.y)
        ) {
          throw new Error("BEL-01B.2a did not receive a valid Send-button target.")
        }

        clickAttempted = true
        await chrome.debugger.sendCommand(
          { tabId: tab.id },
          "Input.dispatchMouseEvent",
          {
            type: "mousePressed",
            x: sendTarget.x,
            y: sendTarget.y,
            button: "left",
            clickCount: 1,
          }
        )
        await chrome.debugger.sendCommand(
          { tabId: tab.id },
          "Input.dispatchMouseEvent",
          {
            type: "mouseReleased",
            x: sendTarget.x,
            y: sendTarget.y,
            button: "left",
            clickCount: 1,
          }
        )

        const submittedReceipt = {
          ...armed,
          status: "submitted_unbound",
          clicked_at: new Date().toISOString(),
          send_selector: sendTarget.selector_hint ?? null,
        }
        await saveSubmissionReceipt(submittedReceipt)

        const binding = await waitForConversationBinding(tab.id, SUBMISSION_BIND_TIMEOUT_MS)
        if (!binding) {
          throw new Error(
            "Prompt may have been submitted, but no conversation binding appeared before timeout. " +
              "Do not retry. Use recover_prompt_submission."
          )
        }

        const bound = {
          ...submittedReceipt,
          status: "bound",
          conversation_id: binding.conversation_id,
          conversation_url: binding.conversation_url,
          bound_at: new Date().toISOString(),
        }
        await saveSubmissionReceipt(bound)
        return publicSubmissionReceipt(bound)
      } catch (error) {
        const current = (await loadSubmissionReceipt(submissionId)) ?? armed
        if (current.status !== "bound") {
          await saveSubmissionReceipt({
            ...current,
            status: "uncertain",
            click_attempted: clickAttempted,
            uncertain_at: new Date().toISOString(),
            last_error: error instanceof Error ? error.message : String(error),
          })
        }
        throw error
      }
    }

    case "recover_prompt_submission": {
      const submissionId = validateSubmissionId(payload.submission_id)
      const receipt = await loadSubmissionReceipt(submissionId)
      if (!receipt) {
        throw new Error(`Unknown submission_id: ${submissionId}`)
      }

      if (receipt.status === "bound") {
        return publicSubmissionReceipt(receipt)
      }

      let tab
      try {
        tab = await chrome.tabs.get(receipt.tab_id)
      } catch {
        const uncertain = {
          ...receipt,
          status: "uncertain",
          recovery_checked_at: new Date().toISOString(),
          recovery_note: "Original child tab no longer exists; submission was not retried.",
        }
        await saveSubmissionReceipt(uncertain)
        return {
          ...publicSubmissionReceipt(uncertain),
          tab_present: false,
          no_resubmit: true,
        }
      }

      if (!tab.url || !isChatGptUrl(tab.url)) {
        const uncertain = {
          ...receipt,
          status: "uncertain",
          recovery_checked_at: new Date().toISOString(),
          recovery_note: "Original tab is no longer a ChatGPT tab; submission was not retried.",
        }
        await saveSubmissionReceipt(uncertain)
        return {
          ...publicSubmissionReceipt(uncertain),
          tab_present: true,
          no_resubmit: true,
        }
      }

      const binding = extractConversationBinding(tab.url)
      if (binding) {
        const bound = {
          ...receipt,
          status: "bound",
          conversation_id: binding.conversation_id,
          conversation_url: binding.conversation_url,
          bound_at: receipt.bound_at ?? new Date().toISOString(),
          recovery_checked_at: new Date().toISOString(),
        }
        await saveSubmissionReceipt(bound)
        return publicSubmissionReceipt(bound)
      }

      const uncertain = {
        ...receipt,
        status: "uncertain",
        recovery_checked_at: new Date().toISOString(),
        recovery_note: "No conversation binding is visible yet; submission was not retried.",
      }
      await saveSubmissionReceipt(uncertain)
      return {
        ...publicSubmissionReceipt(uncertain),
        tab_present: true,
        no_resubmit: true,
      }
    }

    case "detach": {
      const tab = await requireChatGptTab(payload.tab_id)
      turnObservers.delete(tab.id)
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

async function handleTurnObserverEvent(tabId, method, params) {
  const observer = turnObservers.get(tabId)
  if (!observer) return

  if (method === "Network.requestWillBeSent") {
    if (
      params?.request?.method === "POST" &&
      isConversationTurnEndpoint(params?.request?.url) &&
      typeof params?.requestId === "string"
    ) {
      observer.request_ids.add(params.requestId)
    }
    return
  }

  if (method === "Network.responseReceived") {
    if (!observer.request_ids.has(params?.requestId)) return
    const requestId = params.requestId
    await chrome.debugger
      .sendCommand(
        { tabId },
        "Network.streamResourceContent",
        { requestId }
      )
      .then((result) => {
        if (typeof result?.bufferedData !== "string" || !result.bufferedData) return
        return postTurnStreamEvent(
          tabId,
          observer,
          "sse_chunk",
          decodeBase64Utf8(result.bufferedData),
          requestId
        )
      })
      .catch(() => undefined)
    return
  }

  if (method === "Network.dataReceived") {
    if (
      !observer.request_ids.has(params?.requestId) ||
      typeof params?.data !== "string" ||
      !params.data
    ) {
      return
    }
    await postTurnStreamEvent(
      tabId,
      observer,
      "sse_chunk",
      decodeBase64Utf8(params.data),
      params.requestId
    )
    return
  }

  if (method === "Network.loadingFinished") {
    if (!observer.request_ids.has(params?.requestId)) return
    const requestId = params.requestId
    await chrome.debugger
      .sendCommand(
        { tabId },
        "Network.getResponseBody",
        { requestId }
      )
      .then((result) => {
        if (typeof result?.body !== "string" || !result.body) return
        const body = result.base64Encoded ? decodeBase64Utf8(result.body) : result.body
        return postTurnStreamEvent(tabId, observer, "sse_body", body, requestId)
      })
      .catch(() => undefined)
    return
  }

  if (method === "Network.webSocketFrameReceived") {
    const payloadData = params?.response?.payloadData
    if (typeof payloadData === "string" && payloadData) {
      await postTurnStreamEvent(tabId, observer, "ws_frame", payloadData)
    }
  }
}

async function postTurnStreamEvent(tabId, observer, kind, data, requestId) {
  if (!data || turnObservers.get(tabId) !== observer) return
  await postEvent({
    type: "subagent_turn_stream",
    observation_id: observer.observation_id,
    tab_id: tabId,
    kind,
    ...(typeof requestId === "string" ? { request_id: requestId } : {}),
    data,
  })
}

function isConversationTurnEndpoint(value) {
  try {
    const url = new URL(value)
    return (
      url.protocol === "https:" &&
      url.hostname === "chatgpt.com" &&
      url.pathname === "/backend-api/f/conversation"
    )
  } catch {
    return false
  }
}

function validateObservationId(value) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 128 ||
    !/^[A-Za-z0-9._:-]+$/.test(value)
  ) {
    throw new Error("observation_id must be 1-128 safe identifier characters.")
  }
  return value
}

function decodeBase64Utf8(value) {
  const bytes = Uint8Array.from(atob(value), (character) => character.charCodeAt(0))
  return new TextDecoder().decode(bytes)
}

async function evaluateDraftComparison(tabId, expectedText) {
  const evaluation = await chrome.debugger.sendCommand(
    { tabId },
    "Runtime.evaluate",
    {
      expression: buildComposerDraftCompareExpression(expectedText),
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

  return evaluation.result?.value ?? {
    current_length: -1,
    exact_match: false,
    newline_normalized_match: false,
    canonical_match: false,
    submitted: false,
  }
}

async function sha256Hex(text) {
  const bytes = new TextEncoder().encode(text)
  const digest = await crypto.subtle.digest("SHA-256", bytes)
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("")
}

async function loadAgentTurnReceipt(turnId) {
  const key = `bel01_agent_turn:${validateSubmissionId(turnId)}`
  const values = await chrome.storage.local.get(key)
  if (!Object.prototype.hasOwnProperty.call(values, key)) return undefined

  const receipt = values[key]
  if (
    !receipt ||
    typeof receipt !== "object" ||
    receipt.turn_id !== turnId ||
    !Number.isInteger(receipt.tab_id) ||
    typeof receipt.prompt_sha256 !== "string" ||
    typeof receipt.status !== "string"
  ) {
    throw new Error(`Agent turn ledger entry ${turnId} is invalid; refusing fail-open recovery.`)
  }
  return receipt
}

async function saveAgentTurnReceipt(receipt) {
  const turnId = validateSubmissionId(receipt?.turn_id)
  if (!Number.isInteger(receipt?.tab_id)) {
    throw new Error("Agent turn receipt requires an integer tab_id.")
  }
  if (typeof receipt?.prompt_sha256 !== "string" || receipt.prompt_sha256.length !== 64) {
    throw new Error("Agent turn receipt requires a SHA-256 prompt fingerprint.")
  }
  if (!["armed", "bound", "uncertain"].includes(receipt?.status)) {
    throw new Error(`Invalid agent turn receipt status: ${String(receipt?.status)}`)
  }

  const key = `bel01_agent_turn:${turnId}`
  await chrome.storage.local.set({ [key]: receipt })
}

function publicAgentTurnReceipt(receipt) {
  return {
    turn_id: receipt.turn_id,
    status: receipt.status,
    tab_id: receipt.tab_id,
    conversation_id: receipt.conversation_id,
    conversation_url: receipt.conversation_url,
    armed_at: receipt.armed_at,
    clicked_at: receipt.clicked_at,
    bound_at: receipt.bound_at,
    at_most_once: true,
  }
}

async function loadSubmissionReceipt(submissionId) {
  const key = submissionStorageKey(submissionId)
  const values = await chrome.storage.local.get(key)
  if (!Object.prototype.hasOwnProperty.call(values, key)) return undefined

  const receipt = values[key]
  if (
    !receipt ||
    typeof receipt !== "object" ||
    receipt.submission_id !== submissionId ||
    !Number.isInteger(receipt.tab_id) ||
    typeof receipt.prompt_sha256 !== "string" ||
    typeof receipt.status !== "string"
  ) {
    throw new Error(`Submission ledger entry ${submissionId} is invalid; refusing fail-open recovery.`)
  }
  return receipt
}

async function findSubmissionReceiptByTab(tabId) {
  const values = await chrome.storage.local.get(null)
  for (const [key, value] of Object.entries(values)) {
    if (!key.startsWith("bel01_submission:")) continue
    if (!value || typeof value !== "object") {
      throw new Error("Submission ledger contains an invalid entry; refusing fail-open submission.")
    }
    if (value.tab_id === tabId) return value
  }
  return undefined
}

async function saveSubmissionReceipt(receipt) {
  const submissionId = validateSubmissionId(receipt?.submission_id)
  if (!Number.isInteger(receipt?.tab_id)) {
    throw new Error("Submission receipt requires an integer tab_id.")
  }
  if (typeof receipt?.prompt_sha256 !== "string" || receipt.prompt_sha256.length !== 64) {
    throw new Error("Submission receipt requires a SHA-256 prompt fingerprint.")
  }
  if (!["armed", "submitted_unbound", "bound", "uncertain"].includes(receipt?.status)) {
    throw new Error(`Invalid submission receipt status: ${String(receipt?.status)}`)
  }

  const key = submissionStorageKey(submissionId)
  await chrome.storage.local.set({ [key]: receipt })
}

function publicSubmissionReceipt(receipt) {
  return {
    submission_id: receipt.submission_id,
    status: receipt.status,
    tab_id: receipt.tab_id,
    conversation_id: receipt.conversation_id,
    conversation_url: receipt.conversation_url,
    armed_at: receipt.armed_at,
    clicked_at: receipt.clicked_at,
    bound_at: receipt.bound_at,
    click_attempted: receipt.click_attempted,
    recovery_checked_at: receipt.recovery_checked_at,
    at_most_once: true,
  }
}

async function waitForConversationBinding(tabId, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    let tab
    try {
      tab = await chrome.tabs.get(tabId)
    } catch {
      return undefined
    }

    const binding = tab.url ? extractConversationBinding(tab.url) : undefined
    if (binding) return binding
    await delay(100)
  }
  return undefined
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
