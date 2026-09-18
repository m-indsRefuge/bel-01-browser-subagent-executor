import assert from "node:assert/strict"
import test from "node:test"

import {
  MAX_DRAFT_CHARACTERS,
  buildComposerDraftClearExpression,
  buildComposerDraftCompareExpression,
  buildComposerDraftWriteExpression,
  validateComposerDraft,
} from "../browser-extension/composer-draft.js"

test("composer draft validation rejects empty and oversized payloads", () => {
  assert.throws(() => validateComposerDraft(""), /must not be empty/)
  assert.throws(
    () => validateComposerDraft("x".repeat(MAX_DRAFT_CHARACTERS + 1)),
    /exceeds/
  )
  assert.equal(validateComposerDraft("BEL-01 draft canary"), "BEL-01 draft canary")
})

test("composer draft expression safely encodes arbitrary text", () => {
  const text = 'quote " slash \\ newline\n</script> ' + "$" + "{notInterpolation}"
  const expression = buildComposerDraftWriteExpression(text)

  assert.ok(expression.includes(JSON.stringify(text)))
  assert.ok(expression.includes("candidates.length !== 1"))
  assert.ok(expression.includes("refuses to overwrite a non-empty composer"))
})

test("composer draft commands contain no submission primitive", () => {
  const expressions = [
    buildComposerDraftWriteExpression("BEL-01 draft canary"),
    buildComposerDraftClearExpression("BEL-01 draft canary"),
  ]

  const forbidden = [
    ".click(",
    "requestSubmit",
    ".submit(",
    "KeyboardEvent",
    "dispatchKeyEvent",
    "keyDown",
    "keyUp",
    'key: "Enter"',
    "backend-api/conversation",
  ]

  for (const expression of expressions) {
    for (const token of forbidden) {
      assert.equal(
        expression.includes(token),
        false,
        `draft mutation must not contain submission primitive ${token}`
      )
    }

    assert.ok(expression.includes("submitted: false"))
    assert.ok(expression.includes("candidates.length !== 1"))
  }
})

test("composer draft clear reports an empty verified non-submitted composer", () => {
  const expression = buildComposerDraftClearExpression("BEL-01 draft canary")

  assert.ok(expression.includes('const mode = "clear"'))
  assert.ok(expression.includes('const expectedText = mode === "write" ? intendedText : ""'))
  assert.ok(expression.includes("refuses to clear composer content that does not exactly match the expected draft"))
  assert.ok(expression.includes("composer_empty: composerEmpty"))
  assert.ok(expression.includes("verified: true"))
  assert.ok(expression.includes("replace(/\\u200B/g, \"\").trim()"))
  assert.ok(expression.includes("replace(/\\r\\n/g, \"\\n\")"))
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
