import assert from "node:assert/strict"
import test from "node:test"

import { sanitizeCdpEvent, sanitizeUrl } from "../browser-extension/sanitize.js"

test("Chrome bridge sanitizer strips query strings, fragments, and identifier-like path segments", () => {
  assert.equal(
    sanitizeUrl(
      "https://chatgpt.com/backend-api/subscriptions?account_id=91f02dd1-f16d-4bd8-96d8-1ca12855c8e3#fragment"
    ),
    "https://chatgpt.com/backend-api/subscriptions"
  )

  assert.equal(
    sanitizeUrl(
      "https://chatgpt.com/g/g-p-6aac1c54dd108191bc8c802988506a33/c/6aab08c1-0330-83ea-874e-a27025a0c4d6"
    ),
    "https://chatgpt.com/g/g-p-[redacted]/c/[uuid]"
  )

  assert.equal(
    sanitizeUrl(
      "wss://ws.chatgpt.com/p21/ws/user/user-EAnn1FRsNAJwD5B1uvNyWNm5?verify=secret"
    ),
    "wss://ws.chatgpt.com/p21/ws/user/user-[redacted]"
  )

  assert.equal(
    sanitizeUrl(
      "https://files.openai.com/content?id=file_00000000f3f071f78b9667c3a41d9958&sig=secret"
    ),
    "https://files.openai.com/content"
  )
})

test("Chrome bridge sanitizer never forwards websocket payload contents", () => {
  assert.deepEqual(
    sanitizeCdpEvent("Network.webSocketFrameReceived", {
      response: { opcode: 1, payloadData: "super-secret-payload" },
    }),
    {
      opcode: 1,
      payload_length: 20,
    }
  )
})

test("Chrome bridge sanitizer preserves useful request metadata without sensitive query data", () => {
  assert.deepEqual(
    sanitizeCdpEvent("Network.requestWillBeSent", {
      request: {
        url: "https://chatgpt.com/backend-api/conversation/init?secret=1",
        method: "POST",
      },
      type: "Fetch",
    }),
    {
      url: "https://chatgpt.com/backend-api/conversation/init",
      http_method: "POST",
      resource_type: "Fetch",
    }
  )
})
