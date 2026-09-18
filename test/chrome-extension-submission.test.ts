import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

import {
  SEND_BUTTON_SELECTORS,
  SUBMISSION_BIND_TIMEOUT_MS,
  buildSubmitButtonProbeExpression,
  extractConversationBinding,
  submissionStorageKey,
  validateSubmissionId,
} from "../browser-extension/submission.js"

test("submission ids are bounded and deterministic", () => {
  assert.equal(validateSubmissionId("bel01b2-canary-001"), "bel01b2-canary-001")
  assert.equal(submissionStorageKey("bel01b2-canary-001"), "bel01_submission:bel01b2-canary-001")
  assert.throws(() => validateSubmissionId(""), /submission_id/)
  assert.throws(() => validateSubmissionId("bad id"), /submission_id/)
  assert.throws(() => validateSubmissionId("x".repeat(129)), /submission_id/)
})

test("conversation binding accepts only ChatGPT conversation URLs", () => {
  assert.deepEqual(extractConversationBinding("https://chatgpt.com/c/abc-123?foo=bar#frag"), {
    conversation_id: "abc-123",
    conversation_url: "https://chatgpt.com/c/abc-123",
  })

  assert.deepEqual(
    extractConversationBinding("https://chatgpt.com/g/g-p-demo/c/conv-456?temporary-chat=false"),
    {
      conversation_id: "conv-456",
      conversation_url: "https://chatgpt.com/g/g-p-demo/c/conv-456",
    }
  )

  assert.equal(extractConversationBinding("https://chatgpt.com/"), undefined)
  assert.equal(extractConversationBinding("https://example.com/c/abc-123"), undefined)
  assert.equal(extractConversationBinding("https://chatgpt.com/c/web%3Aephemeral"), undefined)
})

test("submission click expression is a single bounded Send-button action", () => {
  const expression = buildSubmitButtonProbeExpression()

  assert.deepEqual(SEND_BUTTON_SELECTORS, [
    'button[data-testid="send-button"]',
    'button[aria-label="Send prompt"]',
    'button[aria-label="Send"]',
  ])
  assert.equal(SUBMISSION_BIND_TIMEOUT_MS, 15_000)
  assert.ok(expression.includes("candidates.length !== 1"))
  assert.ok(expression.includes("click_ready: true"))
  assert.ok(expression.includes("document.elementFromPoint(x, y)"))
  assert.ok(expression.includes("submitted: false"))
  assert.equal(expression.includes("element.click()"), false)

  const forbidden = [
    "KeyboardEvent",
    "dispatchKeyEvent",
    'key: "Enter"',
    'code: "Enter"',
    "requestSubmit",
    ".submit(",
    "backend-api/f/conversation",
  ]

  for (const token of forbidden) {
    assert.equal(expression.includes(token), false, `submission expression must not contain ${token}`)
  }
})

test("service worker persists armed receipt before Send-button click", async () => {
  const source = await readFile(
    new URL("../browser-extension/service-worker.js", import.meta.url),
    "utf8"
  )

  const submitStart = source.indexOf('case "submit_composer_once"')
  const submitEnd = source.indexOf('case "recover_prompt_submission"', submitStart)
  assert.ok(submitStart >= 0 && submitEnd > submitStart)
  const submit = source.slice(submitStart, submitEnd)

  const armedIndex = submit.indexOf("await saveSubmissionReceipt(armed)")
  const clickIndex = submit.indexOf("expression: buildSubmitButtonProbeExpression()")

  assert.ok(armedIndex >= 0)
  assert.ok(clickIndex >= 0)
  assert.ok(armedIndex < clickIndex, "armed receipt must be durable before click is attempted")

  assert.ok(source.includes("prompt_sha256: promptSha256"))
  assert.ok(source.includes("chrome.storage.local.set"))
  assert.ok(source.includes("refusing duplicate submission"))
  assert.ok(source.includes("allows only one first-turn submission per tab"))
  assert.ok(source.includes("findSubmissionReceiptByTab"))
  assert.ok(source.includes("Use recover_prompt_submission instead."))
  assert.ok(source.includes('"Input.dispatchMouseEvent"'))
  assert.ok(source.includes('type: "mousePressed"'))
  assert.ok(source.includes('type: "mouseReleased"'))
  assert.ok(source.includes("waitForConversationBinding"))
  assert.ok(source.includes('status: "submitted_unbound"'))
  assert.ok(source.includes("const submittedReceipt = {"))
  assert.ok(source.includes("...submittedReceipt"))
  assert.ok(source.includes('status: "bound"'))
  assert.ok(source.includes('status: "uncertain"'))
})

test("submission requires exact draft and a fresh unbound child tab", async () => {
  const source = await readFile(
    new URL("../browser-extension/service-worker.js", import.meta.url),
    "utf8"
  )

  assert.ok(source.includes("if (!comparison.exact_match)"))
  assert.ok(source.includes("requires the composer to exactly match the expected prompt"))
  assert.ok(source.includes("requires a fresh ChatGPT child tab with no bound conversation"))
})

test("recovery path cannot resend", async () => {
  const source = await readFile(
    new URL("../browser-extension/service-worker.js", import.meta.url),
    "utf8"
  )

  const start = source.indexOf('case "recover_prompt_submission"')
  const end = source.indexOf('case "detach"', start)
  assert.ok(start >= 0 && end > start)

  const recovery = source.slice(start, end)
  const forbidden = [
    "buildSubmitButtonProbeExpression",
    "Input.dispatchMouseEvent",
    "Input.insertText",
    'key: "Enter"',
    "requestSubmit",
    ".submit(",
  ]

  for (const token of forbidden) {
    assert.equal(recovery.includes(token), false, `recovery must not contain ${token}`)
  }

  assert.ok(recovery.includes("submission was not retried"))
  assert.ok(recovery.includes("no_resubmit: true"))
})


test("ledger tab lock blocks any second first-turn submission on the same tab", async () => {
  const source = await readFile(
    new URL("../browser-extension/service-worker.js", import.meta.url),
    "utf8"
  )

  assert.ok(source.includes("chrome.storage.local.get(null)"))
  assert.ok(source.includes('key.startsWith("bel01_submission:")'))
  assert.ok(source.includes("value.tab_id === tabId"))
  assert.ok(source.includes("This child tab is already tracked by submission_id"))
})


test("bound replay is resolved before live tab validation", async () => {
  const source = await readFile(
    new URL("../browser-extension/service-worker.js", import.meta.url),
    "utf8"
  )

  const start = source.indexOf('case "submit_composer_once"')
  const end = source.indexOf('case "recover_prompt_submission"', start)
  assert.ok(start >= 0 && end > start)

  const submit = source.slice(start, end)
  const loadIndex = submit.indexOf("loadSubmissionReceipt(submissionId)")
  const boundReturnIndex = submit.indexOf('if (existing.status === "bound")')
  const liveTabIndex = submit.indexOf("requireChatGptTab(payload.tab_id)")

  assert.ok(loadIndex >= 0)
  assert.ok(boundReturnIndex > loadIndex)
  assert.ok(liveTabIndex > boundReturnIndex)
})


test("submission ledger never persists prompt text or exposes its hash", async () => {
  const source = await readFile(
    new URL("../browser-extension/service-worker.js", import.meta.url),
    "utf8"
  )

  const armedStart = source.indexOf("const armed = {")
  const armedEnd = source.indexOf("await saveSubmissionReceipt(armed)", armedStart)
  assert.ok(armedStart >= 0 && armedEnd > armedStart)

  const armedBlock = source.slice(armedStart, armedEnd)
  assert.ok(armedBlock.includes("prompt_sha256: promptSha256"))
  assert.equal(armedBlock.includes("text:"), false)

  const publicStart = source.indexOf("function publicSubmissionReceipt")
  const publicEnd = source.indexOf("async function waitForConversationBinding", publicStart)
  assert.ok(publicStart >= 0 && publicEnd > publicStart)

  const publicBlock = source.slice(publicStart, publicEnd)
  assert.equal(publicBlock.includes("prompt_sha256"), false)
})


test("production agent-turn submission is ledgered and replay-safe", async () => {
  const source = await readFile(
    new URL("../browser-extension/service-worker.js", import.meta.url),
    "utf8"
  )

  const start = source.indexOf('case "submit_agent_turn_once"')
  const end = source.indexOf('case "submit_composer_once"', start)
  assert.ok(start >= 0 && end > start)

  const submit = source.slice(start, end)
  const armedIndex = submit.indexOf("await saveAgentTurnReceipt(armed)")
  const clickIndex = submit.indexOf("expression: buildSubmitButtonProbeExpression()")

  assert.ok(armedIndex >= 0)
  assert.ok(clickIndex > armedIndex, "agent turn receipt must be durable before Send is attempted")

  assert.ok(submit.includes('["bound", "armed", "uncertain"].includes(existing.status)'))
  assert.ok(submit.includes("no_resubmit: true"))
  assert.ok(submit.includes("expected_conversation_id"))
  assert.ok(submit.includes("currentBinding.conversation_id !== expectedConversationId"))
  assert.ok(submit.includes("if (!clickAttempted) throw error"))
  assert.ok(submit.includes('status: "uncertain"'))
  assert.ok(submit.includes("await saveAgentTurnReceipt(uncertain)"))

  const forbidden = [
    'key: "Enter"',
    'code: "Enter"',
    "requestSubmit",
    ".submit(",
  ]
  for (const token of forbidden) {
    assert.equal(submit.includes(token), false, `agent turn submit must not contain ${token}`)
  }
})
