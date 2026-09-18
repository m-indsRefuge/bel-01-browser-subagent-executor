import assert from "node:assert/strict"
import test from "node:test"

import {
  COMPOSER_SELECTORS,
  buildComposerInspectionExpression,
} from "../browser-extension/composer-inspection.js"

test("composer inspection targets known textbox shapes", () => {
  assert.ok(COMPOSER_SELECTORS.includes("#prompt-textarea"))
  assert.ok(COMPOSER_SELECTORS.includes('[data-testid="prompt-textarea"]'))
  assert.ok(COMPOSER_SELECTORS.includes('[contenteditable="true"][role="textbox"]'))
})

test("composer inspection expression is structurally read-only", () => {
  const expression = buildComposerInspectionExpression()

  const forbidden = [
    ".textContent",
    ".innerText",
    ".innerHTML",
    ".value",
    ".click(",
    ".focus(",
    "dispatchEvent",
    "execCommand",
  ]

  for (const token of forbidden) {
    assert.equal(expression.includes(token), false, `expression must not contain ${token}`)
  }

  assert.ok(expression.includes("document.querySelectorAll"))
  assert.ok(expression.includes("getBoundingClientRect"))
  assert.ok(expression.includes("getAttribute"))
})
