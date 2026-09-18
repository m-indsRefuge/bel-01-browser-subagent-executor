import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

import {
  DRAFT_STABILIZATION_MS,
  MAX_DRAFT_CHARACTERS,
  buildComposerDraftCompareExpression,
  buildComposerDraftPrepareClearExpression,
  buildComposerDraftPrepareWriteExpression,
  validateComposerDraft,
} from "../browser-extension/composer-draft.js"

test("composer draft validation rejects empty and oversized payloads", () => {
  assert.throws(() => validateComposerDraft(""), /must not be empty/)
  assert.throws(
    () => validateComposerDraft("x".repeat(MAX_DRAFT_CHARACTERS + 1)),
    /exceeds/
  )
  assert.equal(validateComposerDraft("BEL-01 draft canary"), "BEL-01 draft canary")
  assert.equal(DRAFT_STABILIZATION_MS, 750)
})

test("write preparation is bounded to one visible empty editable composer", () => {
  const expression = buildComposerDraftPrepareWriteExpression()

  assert.ok(expression.includes("candidates.length !== 1"))
  assert.ok(expression.includes("refuses to overwrite a non-empty composer"))
  assert.ok(expression.includes("element.focus()"))
  assert.ok(expression.includes("selection_prepared: false"))

  const forbidden = [
    "execCommand",
    ".click(",
    "requestSubmit",
    ".submit(",
    "KeyboardEvent",
    'key: "Enter"',
    "backend-api/conversation",
  ]

  for (const token of forbidden) {
    assert.equal(expression.includes(token), false, `write preparation must not contain ${token}`)
  }
})

test("clear preparation requires exact expected draft and only selects it", () => {
  const expression = buildComposerDraftPrepareClearExpression("BEL-01 draft canary")

  assert.ok(expression.includes("does not exactly match the expected draft"))
  assert.ok(expression.includes("selection_prepared: true"))
  assert.ok(expression.includes("selectNodeContents"))
  assert.ok(expression.includes("setSelectionRange"))
  assert.ok(expression.includes("element.focus()"))

  const forbidden = [
    "execCommand",
    ".click(",
    "requestSubmit",
    ".submit(",
    'key: "Enter"',
  ]

  for (const token of forbidden) {
    assert.equal(expression.includes(token), false, `clear preparation must not contain ${token}`)
  }
})

test("draft comparison probe returns metadata only", () => {
  const expression = buildComposerDraftCompareExpression("BEL-01 draft canary")

  assert.ok(expression.includes("exact_match"))
  assert.ok(expression.includes("newline_normalized_match"))
  assert.ok(expression.includes("canonical_match"))
  assert.ok(expression.includes("first_difference_index"))
  assert.ok(expression.includes("zero_width_count"))
  assert.ok(expression.includes("nbsp_count"))
  assert.ok(expression.includes("trailing_newline_count"))
  assert.ok(expression.includes("submitted: false"))

  const forbidden = [
    "current_text",
    "expected_text:",
    "textContent:",
    "innerText:",
    "value:",
  ]

  for (const token of forbidden) {
    assert.equal(expression.includes(token), false, `comparison must not return ${token}`)
  }
})

test("service worker uses text insertion and backspace only, never Enter or submit", async () => {
  const source = await readFile(
    new URL("../browser-extension/service-worker.js", import.meta.url),
    "utf8"
  )

  assert.ok(source.includes('"Input.insertText"'))
  assert.ok(source.includes('key: "a"'))
  assert.ok(source.includes('code: "KeyA"'))
  assert.ok(source.includes('key: "Backspace"'))
  assert.ok(source.includes("selectAllModifier"))
  assert.ok(source.includes("DRAFT_STABILIZATION_MS"))
  assert.ok(source.includes("Do not retry automatically"))

  const forbidden = [
    'key: "Enter"',
    'code: "Enter"',
    "requestSubmit",
    ".submit(",
    'Input.dispatchKeyEvent",\n        {\n          type: "rawKeyDown",\n          key: "Enter"',
  ]

  for (const token of forbidden) {
    assert.equal(source.includes(token), false, `service worker must not contain submission primitive ${token}`)
  }
})


test("service worker can explicitly reveal only a validated ChatGPT child tab", async () => {
  const source = await readFile(
    new URL("../browser-extension/service-worker.js", import.meta.url),
    "utf8"
  )

  assert.ok(source.includes('case "show_chatgpt_tab"'))
  assert.ok(source.includes("requireChatGptTab(payload.tab_id)"))
  assert.ok(source.includes("chrome.tabs.update(tab.id, { active: true })"))
  assert.ok(source.includes("chrome.windows.update(tab.windowId, { focused: true })"))
})
