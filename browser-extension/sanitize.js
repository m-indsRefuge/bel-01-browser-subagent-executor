export function sanitizeCdpEvent(method, params = {}) {
  switch (method) {
    case "Network.requestWillBeSent":
      return compactObject({
        url: sanitizeUrl(params.request?.url),
        http_method: params.request?.method,
        resource_type: params.type,
      })

    case "Network.responseReceived":
      return compactObject({
        url: sanitizeUrl(params.response?.url),
        status: params.response?.status,
        mime_type: params.response?.mimeType,
        resource_type: params.type,
      })

    case "Network.webSocketCreated":
      return compactObject({ url: sanitizeUrl(params.url) })

    case "Network.webSocketFrameReceived":
    case "Network.webSocketFrameSent":
      return {
        opcode: params.response?.opcode,
        payload_length: typeof params.response?.payloadData === "string" ? params.response.payloadData.length : 0,
      }

    case "Page.frameNavigated":
      return compactObject({
        frame_id: redactIdentifier(params.frame?.id),
        url: sanitizeUrl(params.frame?.url),
      })

    default:
      return {}
  }
}

export function sanitizeUrl(value) {
  if (typeof value !== "string" || value.length === 0) return undefined

  try {
    const url = new URL(value)
    if (!["http:", "https:", "ws:", "wss:"].includes(url.protocol)) return undefined
    return `${url.protocol}//${url.host}${sanitizePathname(url.pathname)}`
  } catch {
    return undefined
  }
}

function sanitizePathname(pathname) {
  return pathname
    .split("/")
    .map((segment) => redactIdentifier(segment))
    .join("/")
}

function redactIdentifier(value) {
  if (typeof value !== "string" || value.length === 0) return value

  if (/^g-p-[A-Za-z0-9_-]+$/.test(value)) return "g-p-[redacted]"
  if (/^file_[A-Za-z0-9_-]+$/.test(value)) return "file_[redacted]"
  if (/^user-[A-Za-z0-9_-]+$/.test(value)) return "user-[redacted]"
  if (/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(value)) return "[uuid]"
  if (/^[A-Za-z0-9_-]{32,}$/.test(value)) return "[id]"

  return value
}

function compactObject(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined))
}
