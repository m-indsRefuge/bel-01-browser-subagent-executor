import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

import {
  MAX_RESPONSE_CHARACTERS,
  RESPONSE_CAPTURE_TIMEOUT_MS,
  RESPONSE_POLL_MAX_WAIT_MS,
  analyzeConversationPayload,
  isConversationPayloadUrl,
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

test("response wait and capture bounds are explicit", () => {
  assert.equal(validateResponseWaitMs(undefined), 0)
  assert.equal(validateResponseWaitMs(0), 0)
  assert.equal(validateResponseWaitMs(RESPONSE_POLL_MAX_WAIT_MS), RESPONSE_POLL_MAX_WAIT_MS)
  assert.throws(() => validateResponseWaitMs(-1), /wait_ms/)
  assert.throws(() => validateResponseWaitMs(RESPONSE_POLL_MAX_WAIT_MS + 1), /wait_ms/)
  assert.throws(() => validateResponseWaitMs(1.5), /wait_ms/)
  assert.equal(RESPONSE_CAPTURE_TIMEOUT_MS, 10_000)
  assert.equal(MAX_RESPONSE_CHARACTERS, 128_000)
})

test("conversation payload URL matcher is exact and ChatGPT-only", () => {
  assert.equal(
    isConversationPayloadUrl(
      `https://chatgpt.com/backend-api/conversations/${CONVERSATION_ID}`,
      CONVERSATION_ID
    ),
    true
  )
  assert.equal(
    isConversationPayloadUrl(
      `https://chatgpt.com/backend-api/conversations/${CONVERSATION_ID}?x=1`,
      CONVERSATION_ID
    ),
    true
  )
  assert.equal(
    isConversationPayloadUrl(
      `https://example.com/backend-api/conversations/${CONVERSATION_ID}`,
      CONVERSATION_ID
    ),
    false
  )
  assert.equal(
    isConversationPayloadUrl(
      "https://chatgpt.com/backend-api/conversations/other",
      CONVERSATION_ID
    ),
    false
  )
})

test("completed first-turn payload returns only the bound assistant response", () => {
  const result = analyzeConversationPayload(
    conversationPayload(),
    CONVERSATION_ID,
    PROMPT
  )

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

test("unfinished assistant response remains running", () => {
  const result = analyzeConversationPayload(
    conversationPayload({ assistantEndTurn: false, assistantText: "partial" }),
    CONVERSATION_ID,
    PROMPT
  )

  assert.deepEqual(result, {
    status: "running",
    user_turn_count: 1,
    conversation_id: CONVERSATION_ID,
  })
})

test("assistant without finished_successfully remains running", () => {
  const result = analyzeConversationPayload(
    conversationPayload({ assistantStatus: "in_progress" }),
    CONVERSATION_ID,
    PROMPT
  )

  assert.deepEqual(result, {
    status: "running",
    user_turn_count: 1,
    conversation_id: CONVERSATION_ID,
  })
})

test("observer refuses prompt mismatch and multiple user turns", () => {
  const promptMismatch = analyzeConversationPayload(
    conversationPayload({ prompt: "different prompt" }),
    CONVERSATION_ID,
    PROMPT
  )
  assert.equal(promptMismatch.status, "binding_mismatch")
  assert.equal(promptMismatch.reason, "prompt_mismatch")

  const multipleUsers = analyzeConversationPayload(
    conversationPayload({ extraUser: true }),
    CONVERSATION_ID,
    PROMPT
  )
  assert.equal(multipleUsers.status, "binding_mismatch")
  assert.equal(multipleUsers.reason, "user_turn_count")
  assert.equal(multipleUsers.user_turn_count, 2)
})

test("oversized responses are explicitly bounded and marked truncated", () => {
  const result = analyzeConversationPayload(
    conversationPayload({ assistantText: "abcdefghij" }),
    CONVERSATION_ID,
    PROMPT,
    4
  )

  assert.equal(result.status, "completed")
  assert.equal(result.response, "abcd")
  assert.equal(result.response_characters, 4)
  assert.equal(result.response_total_characters, 10)
  assert.equal(result.response_truncated, true)
})

test("protocol shape failure is explicit", () => {
  const result = analyzeConversationPayload(
    { unexpected: true },
    CONVERSATION_ID,
    PROMPT
  )

  assert.equal(result.status, "protocol_error")
  assert.equal(result.reason, "conversation payload is missing mapping/current_node")
})

test("service worker captures ChatGPT-owned payload by CDP reload, not synthetic fetch", async () => {
  const source = await readFile(
    new URL("../browser-extension/service-worker.js", import.meta.url),
    "utf8"
  )

  assert.ok(source.includes("captureConversationPayloadViaReload"))
  assert.ok(source.includes('"Page.reload"'))
  assert.ok(source.includes('"Network.responseReceived"'))
  assert.ok(source.includes('"Network.loadingFinished"'))
  assert.ok(source.includes('"Network.getResponseBody"'))
  assert.ok(source.includes("isConversationPayloadUrl"))
  assert.ok(source.includes("analyzeConversationPayload"))

  assert.equal(
    source.includes('fetch("/backend-api/conversations/'),
    false,
    "observer must not synthesize a conversation API request"
  )
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
  assert.ok(observer.includes("captureConversationPayloadViaReload"))
  assert.ok(observer.includes("analyzeConversationPayload"))
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
  assert.ok(persisted.includes("response_sha256"))
  assert.ok(persisted.includes("response_total_characters"))
  assert.equal(persisted.includes("response: responseText"), false)

  const returned = source.slice(returnStart, source.indexOf("}", returnStart) + 1)
  assert.ok(returned.includes("response: responseText"))
})
