const bridgeUrl = document.querySelector("#bridgeUrl")
const token = document.querySelector("#token")
const enabled = document.querySelector("#enabled")
const status = document.querySelector("#status")

const saved = await chrome.storage.local.get({
  bridgeUrl: "http://127.0.0.1:9233",
  token: "",
  enabled: false,
})
bridgeUrl.value = saved.bridgeUrl
token.value = saved.token
enabled.checked = saved.enabled

document.querySelector("#save").addEventListener("click", async () => {
  await chrome.storage.local.set({
    bridgeUrl: bridgeUrl.value.trim(),
    token: token.value.trim(),
    enabled: enabled.checked,
  })
  await chrome.runtime.sendMessage({ type: "config_updated" }).catch(() => undefined)
  status.textContent = "Saved."
})

document.querySelector("#test").addEventListener("click", async () => {
  status.textContent = "Testing…"
  try {
    const response = await fetch(`${bridgeUrl.value.trim()}/health`, { cache: "no-store" })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const payload = await response.json()
    status.textContent = JSON.stringify(payload, null, 2)
  } catch (error) {
    status.textContent = `Bridge test failed: ${error instanceof Error ? error.message : String(error)}`
  }
})
