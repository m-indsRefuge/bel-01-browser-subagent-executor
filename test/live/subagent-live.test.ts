import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import test from "node:test"
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client"

import { MCP_CONFIG } from "../../src/config.js"
import { startMcpHttpServer } from "../integrations/helpers.js"

const LIVE_TEST_ENABLED = process.env.RUN_LIVE_SUBAGENT_TESTS === "1" && !process.env.CI
const LIVE_TIMEOUT_MS = 6 * 60_000
const LIVE_PROCESS_HARD_CAP_MS = 7 * 60_000
const POLL_WAIT_MS = 30_000
const ARTIFACT_DIR = new URL("./artifacts/", import.meta.url)

if (LIVE_TEST_ENABLED) {
  const hardExitTimer = setTimeout(() => {
    console.error("Live subagent test exceeded the 7-minute process hard cap; forcing exit.")
    process.exit(124)
  }, LIVE_PROCESS_HARD_CAP_MS)
  hardExitTimer.unref()
}

interface StructuredRunTurn {
  agent_id: string
  turn_id?: string
  status: "running" | "failed"
  error?: string
}

interface StructuredResultTurn {
  turn_id: string
  status: "running" | "permission_required" | "completed" | "failed"
  activity?: string
  activity_age_ms?: number
  response?: string
  error?: string
}

interface PollDiagnostic {
  elapsed_ms: number
  status: StructuredResultTurn["status"]
  activity?: string
  activity_age_ms?: number
  response_present: boolean
  model_text_excerpt?: string
}

test(
  "live MCP subagent_run/subagent_result preserves response and context across two turns",
  { skip: !LIVE_TEST_ENABLED, timeout: LIVE_TIMEOUT_MS },
  async (t) => {
    const runSuffix = randomUUID().replaceAll("-", "").slice(0, 12)
    const liveAgentId = `live-subagent-${runSuffix}`
    const contextKey = `LIVE_CTX_${runSuffix}`
    const permissionResumeKey = `PERMISSION_RESUMED_${runSuffix}`
    const firstPrompt = [
      "This is a live subagent lifecycle test. Do not use tools.",
      `Remember this exact context key for the next turn: ${contextKey}`,
      "Reply briefly and include the context key in your response.",
    ].join("\n")
    const artifact: Record<string, unknown> = {
      generated_at: new Date().toISOString(),
      agent_id: liveAgentId,
      context_key: contextKey,
    }
    const pollTimeline: Record<string, PollDiagnostic[]> = {}
    artifact.poll_timeline = pollTimeline

    t.after(async () => {
      await writeLiveArtifact(artifact).catch(() => undefined)
    })

    try {
      MCP_CONFIG.chatGpt.transport = "extension"
      Object.assign(MCP_CONFIG.tools, {
        review: false,
        shell: false,
        applyPatch: false,
        clones: false,
        subagents: true,
        web: false,
        skills: false,
        image: false,
        computer: false,
      })
      const running = await startMcpHttpServer()
      t.after(() => running.close().catch(() => undefined))

      const client = new Client({ name: "live-subagent-integration-test", version: "1.0.0" }, { versionNegotiation: { mode: "auto" } })
      t.after(() => client.close().catch(() => undefined))
      await client.connect(new StreamableHTTPClientTransport(new URL(running.url)))

      t.diagnostic("Production MCP server started")

      const firstRun = await client.callTool({
        name: "subagent_run",
        arguments: {
          agents: [{ agent_id: liveAgentId, prompt: firstPrompt }],
        },
      })
      const firstRunTurn = getRunTurn(toolText(firstRun.content))
      assert.equal(firstRunTurn.agent_id, liveAgentId)
      assert.equal(firstRunTurn.status, "running", firstRunTurn.error ?? "subagent_run did not start turn 1")
      assert.ok(firstRunTurn.turn_id)
      t.diagnostic(`Turn 1 submitted: ${firstRunTurn.turn_id}`)

      const firstCompletion = await waitForCompletedTurn(client, firstRunTurn.turn_id, (entry) => {
        ;(pollTimeline.turn_1 ??= []).push(entry)
        t.diagnostic(formatPollDiagnostic("Turn 1", entry))
      })
      const firstResponse = firstCompletion.turn.response ?? ""
      assert.ok(firstResponse.trim(), "Turn 1 must return a non-empty response")
      assert.ok(firstResponse.includes(contextKey), "Turn 1 must include the supplied context key")
      t.diagnostic("Turn 1 completed with a non-empty response containing the supplied context key")

      artifact.turn_1 = {
        turn_id: firstRunTurn.turn_id,
        mcp_response: firstResponse,
      }

      const secondPrompt = "What exact context key did I ask you to remember in my immediately previous message? Include that key in your response."
      const secondRun = await client.callTool({
        name: "subagent_run",
        arguments: {
          agents: [{ agent_id: liveAgentId, prompt: secondPrompt }],
        },
      })
      const secondRunTurn = getRunTurn(toolText(secondRun.content))
      assert.equal(secondRunTurn.agent_id, liveAgentId)
      assert.equal(secondRunTurn.status, "running", secondRunTurn.error ?? "subagent_run did not start turn 2")
      assert.ok(secondRunTurn.turn_id)
      t.diagnostic(`Turn 2 submitted on same agent: ${secondRunTurn.turn_id}`)

      const secondCompletion = await waitForCompletedTurn(client, secondRunTurn.turn_id, (entry) => {
        ;(pollTimeline.turn_2 ??= []).push(entry)
        t.diagnostic(formatPollDiagnostic("Turn 2", entry))
      })
      const secondResponse = secondCompletion.turn.response?.trim()
      assert.ok(secondResponse, "Turn 2 must return a non-empty response")
      assert.ok(secondResponse.includes(contextKey), "Turn 2 must recover context that was only supplied in Turn 1")

      t.diagnostic("Turn 2 recovered context supplied only through Turn 1 using the same public agent_id")

      artifact.turn_2 = {
        turn_id: secondRunTurn.turn_id,
        mcp_response: secondResponse,
        recovered_turn_1_context: true,
      }

      const permissionPrompt = [
        "This is a BSAP permission-control-plane test.",
        "Do not use any tool.",
        "Your task requires the ungranted capability web.",
        "Follow the BSAP child policy: stop and return only the structured permission request envelope for capability web.",
        'Use reason "Need web capability for the protocol acceptance test" and scope "protocol-test-only".',
        `After Byte grants that permission, continue this same task without using any tool and reply briefly with this exact marker: ${permissionResumeKey}`,
      ].join("\n")

      const permissionRun = await client.callTool({
        name: "subagent_run",
        arguments: {
          agents: [{ agent_id: liveAgentId, prompt: permissionPrompt }],
        },
      })
      const permissionRunTurn = getRunTurn(toolText(permissionRun.content))
      assert.equal(permissionRunTurn.agent_id, liveAgentId)
      assert.equal(
        permissionRunTurn.status,
        "running",
        permissionRunTurn.error ?? "permission protocol turn did not start"
      )
      assert.ok(permissionRunTurn.turn_id)
      t.diagnostic(`Permission protocol turn submitted: ${permissionRunTurn.turn_id}`)

      const permissionRequired = await waitForPermissionRequest(
        client,
        permissionRunTurn.turn_id,
        (entry) => {
          ;(pollTimeline.permission_request ??= []).push(entry)
          t.diagnostic(formatPollDiagnostic("Permission request", entry))
        }
      )

      assert.equal(permissionRequired.capability, "web")
      assert.ok(permissionRequired.request_id)
      t.diagnostic(
        `Child requested capability web: ${permissionRequired.request_id}`
      )

      const permissionDecision = await client.callTool({
        name: "subagent_permission",
        arguments: {
          agent_id: liveAgentId,
          request_id: permissionRequired.request_id,
          decision: "grant",
          note: "Granted for BEL-01C protocol acceptance only; do not invoke a tool in this test.",
        },
      })
      const permissionDecisionTurn = getPermissionDecisionTurn(
        toolText(permissionDecision.content)
      )
      assert.equal(permissionDecisionTurn.agent_id, liveAgentId)
      assert.equal(
        permissionDecisionTurn.status,
        "running",
        permissionDecisionTurn.error ?? "permission grant did not resume the child"
      )
      assert.ok(permissionDecisionTurn.turn_id)

      const resumedCompletion = await waitForCompletedTurn(
        client,
        permissionDecisionTurn.turn_id,
        (entry) => {
          ;(pollTimeline.permission_resume ??= []).push(entry)
          t.diagnostic(formatPollDiagnostic("Permission resume", entry))
        }
      )
      const resumedResponse = resumedCompletion.turn.response?.trim()
      assert.ok(resumedResponse, "Permission-resumed turn must return a response")
      assert.ok(
        resumedResponse.includes(permissionResumeKey),
        "Permission-resumed child must continue the original task in the same conversation"
      )

      artifact.permission = {
        request_turn_id: permissionRunTurn.turn_id,
        request_id: permissionRequired.request_id,
        capability: permissionRequired.capability,
        decision: "grant",
        resumed_turn_id: permissionDecisionTurn.turn_id,
        resumed_marker_observed: true,
      }

      artifact.result = "pass"

      t.diagnostic("LIVE SUBAGENT INTEGRATION: PASS")
      t.diagnostic(`Sanitized evidence: ${join(new URL(ARTIFACT_DIR).pathname, "subagent-live-last.json")}`)
    } catch (error) {
      artifact.result = "fail"
      artifact.failure = serializeError(error)
      artifact.failed_at = new Date().toISOString()
      t.diagnostic(`LIVE SUBAGENT INTEGRATION: FAIL ${error instanceof Error ? error.message : String(error)}`)
      throw error
    }
  }
)

function getRunTurn(text: string): StructuredRunTurn {
  const match = text.match(
    /^- agent_id=("(?:\\.|[^"\\])*"|\S+)(?: turn_id=("(?:\\.|[^"\\])*"|\S+))? status=(running|failed)(?: error=("(?:\\.|[^"\\])*"|\S+))?$/m
  )
  assert.ok(match, "subagent_run must return exactly one live turn")
  return {
    agent_id: decodeCompactScalar(match[1]!),
    ...(match[2] ? { turn_id: decodeCompactScalar(match[2]) } : {}),
    status: match[3] as StructuredRunTurn["status"],
    ...(match[4] ? { error: decodeCompactScalar(match[4]) } : {}),
  }
}

async function waitForCompletedTurn(
  client: Client,
  turnId: string,
  onPoll?: (diagnostic: PollDiagnostic) => void
): Promise<{ turn: StructuredResultTurn; observedTexts: string[] }> {
  const deadline = Date.now() + LIVE_TIMEOUT_MS - 15_000
  const startedAt = Date.now()
  const observedTexts: string[] = []

  while (Date.now() < deadline) {
    const remaining = deadline - Date.now()
    const result = await client.callTool({
      name: "subagent_result",
      arguments: {
        turn_ids: [turnId],
        wait_ms: Math.min(POLL_WAIT_MS, Math.max(0, remaining)),
      },
    })
    const text = toolText(result.content)
    observedTexts.push(text)
    const turn = parseResultTurn(text)
    onPoll?.({
      elapsed_ms: Date.now() - startedAt,
      status: turn.status,
      activity: turn.activity,
      activity_age_ms: turn.activity_age_ms,
      response_present: typeof turn.response === "string" && turn.response.length > 0,
      model_text_excerpt: excerpt(observedTexts.at(-1) ?? ""),
    })
    if (turn.status === "completed") return { turn, observedTexts }
    if (turn.status === "permission_required") {
      throw new Error(
        `Live subagent turn unexpectedly requested permission: ${turnId}`
      )
    }
    if (turn.status === "failed") throw new Error(`Live subagent turn failed: ${turn.error ?? turnId}`)
  }

  throw new Error(`Timed out waiting for live subagent turn ${turnId}`)
}

function formatPollDiagnostic(label: string, entry: PollDiagnostic): string {
  const activity = entry.activity ? ` activity=${JSON.stringify(entry.activity)}` : ""
  const age = entry.activity_age_ms === undefined ? "" : ` activity_age_ms=${entry.activity_age_ms}`
  return `${label} poll +${entry.elapsed_ms}ms status=${entry.status}${activity}${age} response=${entry.response_present ? "yes" : "no"}`
}

function excerpt(value: string, max = 800): string | undefined {
  if (!value) return undefined
  return value.length <= max ? value : `${value.slice(0, max)}…`
}

function serializeError(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) return { message: String(error) }
  return {
    name: error.name,
    message: error.message,
    stack: error.stack,
  }
}

function toolText(content: unknown): string {
  if (!Array.isArray(content)) return ""
  return content
    .map((item) => {
      const record = item !== null && typeof item === "object" && !Array.isArray(item) ? (item as Record<string, unknown>) : undefined
      return record?.type === "text" && typeof record.text === "string" ? record.text : ""
    })
    .filter(Boolean)
    .join("\n")
}

async function writeLiveArtifact(artifact: Record<string, unknown>): Promise<void> {
  const directory = new URL(ARTIFACT_DIR)
  await mkdir(directory, { recursive: true })
  await writeFile(new URL("subagent-live-last.json", directory), `${JSON.stringify(artifact, null, 2)}\n`, "utf8")
}

function parseResultTurn(text: string): StructuredResultTurn {
  const match = text.match(
    /^---- turn_id=("(?:\\.|[^"\\])*"|\S+) status=(running|permission_required|completed|failed)(?: activity=("(?:\\.|[^"\\])*"|\S+))?(?: activity_age_ms=(\d+))? ----(?:\n\n([\s\S]*))?$/
  )
  assert.ok(match, "subagent_result must return exactly one live turn")
  const status = match[2] as StructuredResultTurn["status"]
  const body = match[5]
  return {
    turn_id: decodeCompactScalar(match[1]!),
    status,
    ...(match[3] ? { activity: decodeCompactScalar(match[3]) } : {}),
    ...(match[4] ? { activity_age_ms: Number(match[4]) } : {}),
    ...(status === "completed" && body ? { response: body } : {}),
    ...(status === "failed" && body ? { error: body } : {}),
  }
}

function decodeCompactScalar(value: string): string {
  return value.startsWith('"') ? (JSON.parse(value) as string) : value
}


interface StructuredPermissionRequest {
  request_id: string
  capability: string
  reason?: string
  scope?: string
}

interface StructuredPermissionDecisionTurn {
  agent_id: string
  turn_id?: string
  status: "running" | "failed"
  error?: string
}

async function waitForPermissionRequest(
  client: Client,
  turnId: string,
  onPoll?: (diagnostic: PollDiagnostic) => void
): Promise<StructuredPermissionRequest> {
  const deadline = Date.now() + LIVE_TIMEOUT_MS - 15_000
  const startedAt = Date.now()

  while (Date.now() < deadline) {
    const remaining = deadline - Date.now()
    const result = await client.callTool({
      name: "subagent_result",
      arguments: {
        turn_ids: [turnId],
        wait_ms: Math.min(POLL_WAIT_MS, Math.max(0, remaining)),
      },
    })

    const structured = result.structuredContent as
      | { turns?: Array<Record<string, unknown>> }
      | undefined
    const turn = structured?.turns?.[0]
    const status =
      turn?.status === "running" ||
      turn?.status === "permission_required" ||
      turn?.status === "completed" ||
      turn?.status === "failed"
        ? turn.status
        : undefined

    onPoll?.({
      elapsed_ms: Date.now() - startedAt,
      status: status ?? "failed",
      activity: typeof turn?.activity === "string" ? turn.activity : undefined,
      activity_age_ms:
        typeof turn?.activity_age_ms === "number"
          ? turn.activity_age_ms
          : undefined,
      response_present: typeof turn?.response === "string",
      model_text_excerpt: excerpt(toolText(result.content)),
    })

    if (status === "permission_required") {
      const permission = turn?.permission_request
      if (!permission || typeof permission !== "object" || Array.isArray(permission)) {
        throw new Error("permission_required result did not include permission_request")
      }
      const record = permission as Record<string, unknown>
      if (
        typeof record.request_id !== "string" ||
        typeof record.capability !== "string"
      ) {
        throw new Error("permission_request is missing request_id or capability")
      }
      return {
        request_id: record.request_id,
        capability: record.capability,
        ...(typeof record.reason === "string" ? { reason: record.reason } : {}),
        ...(typeof record.scope === "string" ? { scope: record.scope } : {}),
      }
    }

    if (status === "completed") {
      throw new Error(
        "Permission protocol turn completed without requesting the required capability"
      )
    }
    if (status === "failed") {
      throw new Error(
        `Permission protocol turn failed: ${String(turn?.error ?? turnId)}`
      )
    }
  }

  throw new Error(`Timed out waiting for permission request from ${turnId}`)
}

function getPermissionDecisionTurn(text: string): StructuredPermissionDecisionTurn {
  const match = text.match(
    /agent_id=("(?:\\.|[^"\\])*"|\S+)(?:\s+turn_id=("(?:\\.|[^"\\])*"|\S+))?\s+status=(running|failed)(?:\s+error=("(?:\\.|[^"\\])*"|\S+))?/
  )
  assert.ok(match, "subagent_permission must return one decision turn")
  return {
    agent_id: decodeCompactScalar(match[1]!),
    ...(match[2] ? { turn_id: decodeCompactScalar(match[2]) } : {}),
    status: match[3] as StructuredPermissionDecisionTurn["status"],
    ...(match[4] ? { error: decodeCompactScalar(match[4]) } : {}),
  }
}
