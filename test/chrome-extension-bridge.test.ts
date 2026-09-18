import assert from "node:assert/strict"
import test from "node:test"

// @ts-expect-error plain ESM script has no declaration file.
import { createBridgeServer } from "../scripts/chrome-extension-bridge.mjs"

test("Chrome extension bridge requires auth and round-trips commands", async (t) => {
  const token = "test-token"
  const bridge = createBridgeServer({ host: "127.0.0.1", port: 0, token })
  const bound = await bridge.start()
  t.after(() => bridge.close())

  const unauthorized = await fetch(`${bound.url}/operator/command`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "ping" }),
  })
  assert.equal(unauthorized.status, 401)

  const created = await fetch(`${bound.url}/operator/command`, {
    method: "POST",
    headers: auth(token),
    body: JSON.stringify({ type: "list_tabs", payload: {} }),
  })
  assert.equal(created.status, 202)
  const { id } = await created.json()

  const next = await fetch(`${bound.url}/extension/next?client_id=test-extension`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  assert.equal(next.status, 200)
  const command = await next.json()
  assert.equal(command.id, id)
  assert.equal(command.type, "list_tabs")
  assert.deepEqual(command.payload, {})
  assert.equal(typeof command.created_at, "string")
})

test("Chrome extension bridge stores results and event envelopes", async (t) => {
  const token = "test-token"
  const bridge = createBridgeServer({ host: "127.0.0.1", port: 0, token })
  const bound = await bridge.start()
  t.after(() => bridge.close())

  const created = await fetch(`${bound.url}/operator/command`, {
    method: "POST",
    headers: auth(token),
    body: JSON.stringify({ type: "ping", payload: {} }),
  })
  const { id } = await created.json()

  await fetch(`${bound.url}/extension/next?client_id=test-extension`, {
    headers: { Authorization: `Bearer ${token}` },
  })

  const accepted = await fetch(`${bound.url}/extension/result`, {
    method: "POST",
    headers: auth(token),
    body: JSON.stringify({ id, ok: true, result: { runtime_id: "abc" } }),
  })
  assert.equal(accepted.status, 202)

  const result = await fetch(`${bound.url}/operator/result/${id}`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  assert.equal(result.status, 200)
  const resultBody = await result.json()
  assert.equal(resultBody.ok, true)
  assert.deepEqual(resultBody.result, { runtime_id: "abc" })

  await fetch(`${bound.url}/extension/event`, {
    method: "POST",
    headers: auth(token),
    body: JSON.stringify({ type: "cdp_event", tab_id: 7, method: "Network.responseReceived" }),
  })

  const events = await fetch(`${bound.url}/operator/events`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  const eventsBody = await events.json()
  assert.equal(eventsBody.events.length, 1)
  assert.equal(eventsBody.events[0].tab_id, 7)
})

function auth(token: string) {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  }
}
