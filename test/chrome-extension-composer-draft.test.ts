import assert from "node:assert/strict"
import test from "node:test"

import {
  MAX_DRAFT_CHARACTERS,
  buildComposerDraftClearExpression,
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
    buildComposerDraftClearExpression(),
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
  const expression = buildComposerDraftClearExpression()

  assert.ok(expression.includes('const mode = "clear"'))
  assert.ok(expression.includes('const expectedText = mode === "write" ? intendedText : ""'))
  assert.ok(expression.includes("composer_empty: composerEmpty"))
  assert.ok(expression.includes("verified: true"))
  assert.ok(expression.includes("replace(/\\u200B/g, \"\").trim()"))
})
