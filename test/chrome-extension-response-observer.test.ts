import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

import {
  MAX_RESPONSE_CHARACTERS,
  RESPONSE_POLL_INTERVAL_MS,
  RESPONSE_POLL_MAX_WAIT_MS,
  buildConversationSnapshotExpression,
  validateResponseWaitMs,
} from "../browser-extension/response-observer.js"

const PROMPT = "Reply with exactly: BEL-01B.2 ACK"
const CONVERSATION_ID = "conversation-123"

function conversationPayload({
  prompt = PROMPT,
  assistantText = "BEL-01B.2 ACK",
  assistantEndTurn = true,
  assistantStatus = "finished_successfully",
  extraUser = false,
}: {
  prompt?: string
  assistantText?: string
  assistantEndTurn?: boolean
  assistantStatus?: string
  extraUser?: boolean
} = {}) {
  const mapping: Record<string, unknown> = {
    root: {
      parent: null,
      message: null,
    },
    user: {
      parent: "root",
      message: {
        author: { role: "user" },
        content: { parts: [prompt] },
      },
    },
    assistant: {
      parent: extraUser ? "user2" : "user",
      message: {
        author: { role: "assistant" },
        content: { parts: [assistantText] },
        end_turn: assistantEndTurn,
        status: assistantStatus,
        recipient: "all",
      },
    },
  }

  if (extraUser) {
    mapping.user2 = {
      parent: "user",
      message: {
        author: { role: "user" },
        content: { parts: ["second user turn"] },
      },
    }
  }

  return {
    current_node: "assistant",
    mapping,
  }
}

async function evaluateWithPayload(
  payload: unknown,
  expectedPrompt = PROMPT,
  maxResponseCharacters?: number
) {
  const expression = buildConversationSnapshotExpression(
    CONVERSATION_ID,
    expectedPrompt,
    maxResponseCharacters
  )
  const originalFetch = globalThis.fetch

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    assert.equal(
      String(input),
      `/backend-api/conversations/${encodeURIComponent(CONVERSATION_ID)}`
    )
    assert.equal(init?.method, "GET")
    assert.equal(init?.credentials, "include")
    return {
      ok: true,
      status: 200,
      async json() {
        return payload
      },
    } as Response
  }) as typeof fetch

  try {
    return await (0, eval)(expression)
  } finally {
    globalThis.fetch = originalFetch
  }
}

test("response wait bounds are explicit", () => {
  assert.equal(validateResponseWaitMs(undefined), 0)
  assert.equal(validateResponseWaitMs(0), 0)
  assert.equal(validateResponseWaitMs(RESPONSE_POLL_MAX_WAIT_MS), RESPONSE_POLL_MAX_WAIT_MS)
  assert.throws(() => validateResponseWaitMs(-1), /wait_ms/)
  assert.throws(() => validateResponseWaitMs(RESPONSE_POLL_MAX_WAIT_MS + 1), /wait_ms/)
  assert.throws(() => validateResponseWaitMs(1.5), /wait_ms/)
  assert.equal(RESPONSE_POLL_INTERVAL_MS, 250)
  assert.equal(MAX_RESPONSE_CHARACTERS, 128_000)
})

test("completed first-turn conversation returns only the bound assistant response", async () => {
  const result = await evaluateWithPayload(conversationPayload())

  assert.deepEqual(result, {
    status: "completed",
    conversation_id: CONVERSATION_ID,
    user_turn_count: 1,
    assistant_status: "finished_successfully",
    response: "BEL-01B.2 ACK",
    response_characters: 13,
    response_total_characters: 13,
    response_truncated: false,
  })
})

test("unfinished assistant response remains running", async () => {
  const result = await evaluateWithPayload(
    conversationPayload({ assistantEndTurn: false, assistantText: "partial" })
  )

  assert.deepEqual(result, {
    status: "running",
    user_turn_count: 1,
    conversation_id: CONVERSATION_ID,
  })
})

test("observer refuses prompt mismatch and multiple user turns", async () => {
  const promptMismatch = await evaluateWithPayload(
    conversationPayload({ prompt: "different prompt" })
  )
  assert.equal(promptMismatch.status, "binding_mismatch")
  assert.equal(promptMismatch.reason, "prompt_mismatch")

  const multipleUsers = await evaluateWithPayload(
    conversationPayload({ extraUser: true })
  )
  assert.equal(multipleUsers.status, "binding_mismatch")
  assert.equal(multipleUsers.reason, "user_turn_count")
  assert.equal(multipleUsers.user_turn_count, 2)
})

test("oversized responses are explicitly bounded and marked truncated", async () => {
  const result = await evaluateWithPayload(
    conversationPayload({ assistantText: "abcdefghij" }),
    PROMPT,
    4
  )

  assert.equal(result.status, "completed")
  assert.equal(result.response, "abcd")
  assert.equal(result.response_characters, 4)
  assert.equal(result.response_total_characters, 10)
  assert.equal(result.response_truncated, true)
})

test("observer expression contains no browser mutation or submission path", () => {
  const expression = buildConversationSnapshotExpression(CONVERSATION_ID, PROMPT)

  assert.ok(expression.includes("/backend-api/conversations/"))
  assert.ok(expression.includes('credentials: "include"'))
  assert.ok(expression.includes('status: "binding_mismatch"'))
  assert.ok(expression.includes('status: "completed"'))

  const forbidden = [
    "document.querySelector",
    "element.click",
    "dispatchEvent",
    "KeyboardEvent",
    "Input.insertText",
    "Input.dispatchMouseEvent",
    "requestSubmit",
    ".submit(",
  ]

  for (const token of forbidden) {
    assert.equal(expression.includes(token), false, `observer expression must not contain ${token}`)
  }
})

test("service worker observer is receipt-bound and structurally non-submitting", async () => {
  const source = await readFile(
    new URL("../browser-extension/service-worker.js", import.meta.url),
    "utf8"
  )

  const start = source.indexOf('case "observe_submission_response"')
  const end = source.indexOf('case "detach"', start)
  assert.ok(start >= 0 && end > start)

  const observer = source.slice(start, end)
  assert.ok(observer.includes('receipt.status !== "bound"'))
  assert.ok(observer.includes("receipt.prompt_sha256 !== promptSha256"))
  assert.ok(observer.includes("currentBinding.conversation_id !== receipt.conversation_id"))
  assert.ok(observer.includes("evaluateResponseSnapshot"))
  assert.ok(observer.includes('status: "completed"'))
  assert.ok(observer.includes('status: "running"'))

  const forbidden = [
    "buildSubmitButtonProbeExpression",
    "Input.dispatchMouseEvent",
    "Input.insertText",
    "write_composer_draft",
    "clear_composer_draft",
    "submit_composer_once",
  ]

  for (const token of forbidden) {
    assert.equal(observer.includes(token), false, `observer command must not contain ${token}`)
  }
})

test("completed response text is returned but not persisted in the submission ledger", async () => {
  const source = await readFile(
    new URL("../browser-extension/service-worker.js", import.meta.url),
    "utf8"
  )

  const start = source.indexOf('if (snapshot.status === "completed")')
  const saveStart = source.indexOf("await saveSubmissionReceipt({", start)
  const saveEnd = source.indexOf("})", saveStart)
  const returnStart = source.indexOf("return {", saveEnd)

  assert.ok(start >= 0 && saveStart > start && saveEnd > saveStart && returnStart > saveEnd)

  const persisted = source.slice(saveStart, saveEnd)
  assert.ok(persisted.includes("assistant_sha256"))
  assert.ok(persisted.includes("assistant_characters"))
  assert.equal(persisted.includes("response: responseText"), false)

  const returned = source.slice(returnStart, source.indexOf("}", returnStart) + 1)
  assert.ok(returned.includes("response: responseText"))
})
