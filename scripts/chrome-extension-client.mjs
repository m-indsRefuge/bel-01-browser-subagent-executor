import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const repoRoot = fileURLToPath(new URL("../", import.meta.url))
const tokenPath = join(repoRoot, ".shellby", "chrome-extension-bridge.token")
const baseUrl = process.env.BEL01_BRIDGE_URL ?? "http://127.0.0.1:9233"
const token = (process.env.BEL01_BRIDGE_TOKEN ?? (await readFile(tokenPath, "utf8"))).trim()
const waitMs = Number.parseInt(process.env.BEL01_BRIDGE_WAIT_MS ?? "60000", 10)
const pollMs = Number.parseInt(process.env.BEL01_BRIDGE_RESULT_POLL_MS ?? "250", 10)

const [command, payloadSource] = process.argv.slice(2)
if (!command) {
  console.error("Usage: node scripts/chrome-extension-client.mjs <command> [json-payload]")
  process.exit(2)
}

const payload = payloadSource ? JSON.parse(payloadSource) : {}
const created = await request("/operator/command", {
  method: "POST",
  body: JSON.stringify({ type: command, payload }),
})
const id = created.id

const deadline = Date.now() + waitMs
while (Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, pollMs))
  const response = await fetch(`${baseUrl}/operator/result/${encodeURIComponent(id)}`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (response.status === 202) continue
  if (!response.ok) throw new Error(`Bridge returned HTTP ${response.status}: ${await response.text()}`)
  const result = await response.json()
  console.log(JSON.stringify(result, null, 2))
  process.exit(result.ok ? 0 : 1)
}

const health = await fetch(`${baseUrl}/health`, { cache: "no-store" })
  .then((response) => (response.ok ? response.json() : null))
  .catch(() => null)

throw new Error(
  `Timed out waiting for bridge command ${id} after ${waitMs}ms.` +
    (health ? ` Bridge health: ${JSON.stringify(health)}` : "")
)

async function request(path, init = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  })
  if (!response.ok) throw new Error(`Bridge returned HTTP ${response.status}: ${await response.text()}`)
  return response.json()
}
