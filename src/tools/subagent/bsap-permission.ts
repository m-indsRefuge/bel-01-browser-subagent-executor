const PERMISSION_REQUEST_PATTERN =
  /<bsap_permission_request>\s*([\s\S]*?)\s*<\/bsap_permission_request>/

export interface ParsedBsapPermissionRequest {
  capability: string
  reason: string
  scope?: string
}

export function parseBsapPermissionRequest(
  response: string
): ParsedBsapPermissionRequest | undefined {
  const match = response.match(PERMISSION_REQUEST_PATTERN)
  if (!match?.[1]) return undefined

  let value: unknown
  try {
    value = JSON.parse(match[1])
  } catch {
    return undefined
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const capability =
    typeof record.capability === "string" ? record.capability.trim() : ""
  const reason = typeof record.reason === "string" ? record.reason.trim() : ""
  const scope = typeof record.scope === "string" ? record.scope.trim() : undefined

  if (!/^[a-z][a-z0-9._:-]{0,63}$/.test(capability)) return undefined
  if (reason.length < 1 || reason.length > 1_000) return undefined
  if (scope !== undefined && (scope.length < 1 || scope.length > 1_000)) {
    return undefined
  }

  return {
    capability,
    reason,
    ...(scope ? { scope } : {}),
  }
}

export function bsapChildPolicy(grants: readonly string[]): string {
  const granted = grants.length > 0 ? grants.join(", ") : "reasoning-only"
  return [
    "BSAP child policy:",
    `Granted capabilities: ${granted}.`,
    "Do not use capabilities outside that grant.",
    "If the task requires an ungranted capability, stop before using it and respond only with:",
    "<bsap_permission_request>",
    '{"capability":"capability.id","reason":"why it is required","scope":"smallest useful scope"}',
    "</bsap_permission_request>",
    "Wait for Byte's grant or denial before continuing.",
    "Never spawn another subagent.",
  ].join("\n")
}

export function bsapPermissionDecisionPrompt(input: {
  requestId: string
  capability: string
  decision: "grant" | "deny"
  note?: string
}): string {
  return [
    `BSAP permission decision for request ${input.requestId}:`,
    `Capability: ${input.capability}`,
    `Decision: ${input.decision.toUpperCase()}`,
    ...(input.note ? [`Parent note: ${input.note}`] : []),
    input.decision === "grant"
      ? "The capability is now granted for this child. Continue the original task within the granted scope."
      : "The capability is not granted. Do not use it. Continue by adapting within existing grants, or report that the task is blocked.",
  ].join("\n")
}
