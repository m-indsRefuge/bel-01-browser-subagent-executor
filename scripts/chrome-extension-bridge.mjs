import { randomBytes, randomUUID } from "node:crypto"
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const repoRoot = fileURLToPath(new URL("../", import.meta.url))
const DEFAULT_HOST = "127.0.0.1"
const DEFAULT_PORT = Number.parseInt(process.env.BEL01_BRIDGE_PORT ?? "9233", 10)
const DEFAULT_TOKEN_PATH = join(repoRoot, ".shellby", "chrome-extension-bridge.token")
const MAX_BODY_BYTES = 2 * 1024 * 1024
const MAX_EVENTS = 500
const LONG_POLL_MS = Number.parseInt(process.env.BEL01_BRIDGE_LONG_POLL_MS ?? "10000", 10)
const COMMAND_TTL_MS = Number.parseInt(process.env.BEL01_BRIDGE_COMMAND_TTL_MS ?? "45000", 10)

export async function loadOrCreateBridgeToken(path = DEFAULT_TOKEN_PATH) {
  try {
    const existing = (await readFile(path, "utf8")).trim()
    if (existing) return existing
  } catch (error) {
    if (error?.code !== "ENOENT") throw error
  }

  await mkdir(dirname(path), { recursive: true })
  const token = randomBytes(32).toString("hex")
  await writeFile(path, `${token}\n`, { mode: 0o600, flag: "wx" }).catch(async (error) => {
    if (error?.code !== "EEXIST") throw error
  })
  await chmod(path, 0o600)
  return (await readFile(path, "utf8")).trim()
}

export function createBridgeServer({
  host = DEFAULT_HOST,
  port = DEFAULT_PORT,
  token,
  longPollMs = LONG_POLL_MS,
  commandTtlMs = COMMAND_TTL_MS,
}) {
  if (!token) throw new Error("BEL-01 Chrome bridge requires an authentication token.")

  const commands = []
  const results = new Map()
  const events = []
  const waiters = new Set()
  const eventWaiters = new Set()
  let nextEventSequence = 1
  let extensionLastSeenAt = null
  let extensionClientId = null

  const server = createServer(async (req, res) => {
    setCors(res)

    if (req.method === "OPTIONS") {
      res.writeHead(204).end()
      return
    }

    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? `${host}:${port}`}`)

    try {
      if (req.method === "GET" && url.pathname === "/health") {
        sendJson(res, 200, {
          ok: true,
          service: "bel-01-chrome-extension-bridge",
          extension_connected: extensionLastSeenAt !== null && Date.now() - extensionLastSeenAt < 45_000,
          extension_client_id: extensionClientId,
          queued_commands: commands.length,
          oldest_queued_age_ms:
            commands.length > 0 ? Math.max(0, Date.now() - Date.parse(commands[0].created_at)) : 0,
          pending_results: results.size,
          event_count: events.length,
        })
        return
      }

      if (!authorized(req, token)) {
        sendJson(res, 401, { error: "unauthorized" })
        return
      }

      if (req.method === "POST" && url.pathname === "/operator/command") {
        const body = await readJson(req)
        if (!body || typeof body.type !== "string" || body.type.length === 0) {
          sendJson(res, 400, { error: "command type is required" })
          return
        }

        const now = Date.now()
        const command = {
          id: randomUUID(),
          type: body.type,
          payload: body.payload && typeof body.payload === "object" ? body.payload : {},
          created_at: new Date(now).toISOString(),
          expires_at: new Date(now + commandTtlMs).toISOString(),
        }
        commands.push(command)
        wakeOneWaiter()
        sendJson(res, 202, { id: command.id })
        return
      }

      const resultMatch = req.method === "GET" ? url.pathname.match(/^\/operator\/result\/([^/]+)$/) : null
      if (resultMatch) {
        const id = decodeURIComponent(resultMatch[1])
        const result = results.get(id)
        if (!result) {
          sendJson(res, 202, { id, status: "pending" })
          return
        }
        results.delete(id)
        sendJson(res, 200, result)
        return
      }

      if (req.method === "GET" && url.pathname === "/operator/events") {
        const after = parseNonnegativeInteger(url.searchParams.get("after"), 0)
        const waitMs = Math.min(
          parseNonnegativeInteger(url.searchParams.get("wait_ms"), 0),
          30_000
        )

        if (waitMs > 0 && !events.some((event) => event.sequence > after)) {
          await waitForEvent(waitMs)
        }

        const selected = events.filter((event) => event.sequence > after)
        sendJson(res, 200, {
          events: selected,
          next_sequence:
            selected.at(-1)?.sequence ??
            events.at(-1)?.sequence ??
            after,
          oldest_sequence: events[0]?.sequence ?? nextEventSequence,
        })
        return
      }

      if (req.method === "GET" && url.pathname === "/extension/next") {
        extensionLastSeenAt = Date.now()
        extensionClientId = url.searchParams.get("client_id") || "unknown"

        expireQueuedCommands()
        if (commands.length === 0) await waitForCommand()
        expireQueuedCommands()
        const command = commands.shift()

        if (!command) {
          res.writeHead(204).end()
          return
        }

        sendJson(res, 200, command)
        return
      }

      if (req.method === "POST" && url.pathname === "/extension/result") {
        extensionLastSeenAt = Date.now()
        const body = await readJson(req)
        if (!body || typeof body.id !== "string") {
          sendJson(res, 400, { error: "result id is required" })
          return
        }
        results.set(body.id, {
          id: body.id,
          ok: body.ok === true,
          result: body.result,
          error: typeof body.error === "string" ? body.error : undefined,
          received_at: new Date().toISOString(),
        })
        sendJson(res, 202, { accepted: true })
        return
      }

      if (req.method === "POST" && url.pathname === "/extension/event") {
        extensionLastSeenAt = Date.now()
        const body = await readJson(req)
        const event = {
          ...body,
          sequence: nextEventSequence++,
          received_at: new Date().toISOString(),
        }
        events.push(event)
        if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS)
        wakeEventWaiters()
        sendJson(res, 202, { accepted: true, sequence: event.sequence })
        return
      }

      sendJson(res, 404, { error: "not_found" })
    } catch (error) {
      sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
    }
  })

  function waitForCommand() {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        waiters.delete(done)
        resolve()
      }, longPollMs)
      const done = () => {
        clearTimeout(timer)
        waiters.delete(done)
        resolve()
      }
      waiters.add(done)
    })
  }

  function wakeOneWaiter() {
    const waiter = waiters.values().next().value
    waiter?.()
  }

  function waitForEvent(timeoutMs) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        eventWaiters.delete(done)
        resolve()
      }, timeoutMs)
      const done = () => {
        clearTimeout(timer)
        eventWaiters.delete(done)
        resolve()
      }
      eventWaiters.add(done)
    })
  }

  function wakeEventWaiters() {
    for (const waiter of [...eventWaiters]) waiter()
  }

  function expireQueuedCommands() {
    const now = Date.now()
    for (let index = commands.length - 1; index >= 0; index -= 1) {
      const command = commands[index]
      const expiresAt = Date.parse(command.expires_at)
      if (!Number.isFinite(expiresAt) || expiresAt > now) continue

      commands.splice(index, 1)
      if (!results.has(command.id)) {
        results.set(command.id, {
          id: command.id,
          ok: false,
          error: "BEL-01 bridge command expired before extension delivery; it was not executed.",
          received_at: new Date().toISOString(),
        })
      }
    }
  }

  return {
    server,
    async start() {
      await new Promise((resolve, reject) => {
        server.once("error", reject)
        server.listen(port, host, () => {
          server.off("error", reject)
          resolve()
        })
      })
      const address = server.address()
      if (!address || typeof address === "string") throw new Error("Bridge did not bind to a TCP address.")
      return { host: address.address, port: address.port, url: `http://${address.address}:${address.port}` }
    },
    async close() {
      for (const waiter of [...waiters]) waiter()
      for (const waiter of [...eventWaiters]) waiter()
      await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
    },
  }
}

function authorized(req, token) {
  return req.headers.authorization === `Bearer ${token}`
}

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*")
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type")
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
  res.setHeader("Cache-Control", "no-store")
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  })
  res.end(body)
}

async function readJson(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new Error("request body too large")
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString("utf8"))
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const token = await loadOrCreateBridgeToken()
  const bridge = createBridgeServer({ token })
  const bound = await bridge.start()

  console.log("BEL-01 Chrome extension bridge: ready")
  console.log(`URL: ${bound.url}`)
  console.log(`Token: ${token}`)
  console.log("The bridge listens on Windows/WSL loopback only.")
  console.log("Press Ctrl+C to stop.")

  const stop = async () => {
    await bridge.close().catch(() => undefined)
    process.exit(0)
  }
  process.once("SIGINT", stop)
  process.once("SIGTERM", stop)
}

function parseNonnegativeInteger(value, fallback) {
  if (typeof value !== "string" || value.length === 0) return fallback
  const parsed = Number.parseInt(value, 10)
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback
}
