import { join } from "node:path"

import { MCP_CONFIG } from "../../config.js"
import { getAgentIdentity, type AgentIdentity } from "../../server/agent-context.js"
import {
  delay,
  extractConversationId,
  isChatGptUrl,
  throwIfAborted,
  waitForPromise,
} from "./chatgpt-subagent-browser.js"
import type { AssistantResponseObservation } from "./chatgpt-subagent-observer.js"
import { createExtensionSubagentTransport } from "./chatgpt-subagent-extension-transport.js"
import { createPlaywrightSubagentTransport } from "./chatgpt-subagent-playwright-transport.js"
import type {
  ChatGptManagedPage,
  ChatGptSubagentTransport,
} from "./chatgpt-subagent-transport.js"
import {
  bsapChildPolicy,
  bsapPermissionDecisionPrompt,
  parseBsapPermissionRequest,
} from "./bsap-permission.js"
import { createSubagentStore } from "./subagent-store.js"
import {
  ChatGptSubagentError,
  type ChatGptSubagentCallContext,
  type ChatGptCloneRunRequest,
  type ChatGptCloneSelfRequest,
  type ChatGptPermissionDecisionRequest,
  type ChatGptPermissionRequest,
  type ChatGptSubagentActivity,
  type ChatGptSubagentPollResult,
  type ChatGptSubagentRequest,
  type ChatGptSubagentService,
} from "./chatgpt-subagent-contracts.js"

const AGENT_IDLE_TTL_MS = 30 * 60_000
const STALE_TURN_RECOVERY_MS = 3 * 60_000
const CLEANUP_INTERVAL_MS = 60_000
const MIN_INTER_TURN_DELAY_MS = 1_500
const INTERACTION_DELAY_MS = 300
const RATE_LIMIT_COOLDOWN_MS = 15 * 60_000
const RATE_LIMIT_DISMISS_SETTLE_MS = 250
const CLONE_INITIAL_SETTLE_MS = 5_000
const RATE_LIMIT_ERROR_MESSAGE =
  "ChatGPT temporarily rate limited conversation access. New subagent turns are blocked during a 15-minute cooldown. Existing turns remain available through subagent_result. Do not retry automatically."
const SUBMISSION_GRACE_MS = 500
const TEMPORARY_CHAT_URL = "https://chatgpt.com/?temporary-chat=true"
const CHATGPT_START_URL = MCP_CONFIG.chatGpt.projectUrl

const INJECTED_PROMPT = `Oververbosity: 1.\n\nDo not use \`subagent\`${MCP_CONFIG.tools.computer ? " or `computer_*`" : ""} tools.`
type BrowserAgentStatus = "idle" | "uncertain" | ChatGptSubagentActivity

interface BrowserAgentState {
  agentId: string
  kind: "subagent" | "clone"
  memory: boolean
  status: BrowserAgentStatus
  page?: ChatGptManagedPage
  conversationUrl?: string
  lastCompletedAt?: number
  lastUsedAt: number
  turnCount: number
  grants: Set<string>
  pendingPermission?: ChatGptPermissionRequest
}

interface BrowserTurnState {
  turnId: string
  agentId: string
  parentAgent?: AgentIdentity
  status: "running" | "permission_required" | "completed" | "failed"
  recoveryAttempted: boolean
  lastActivityAt: number
  response?: string
  errorCode?: string
  errorMessage?: string
  permissionRequest?: ChatGptPermissionRequest
  prompt: string
  observation?: AssistantResponseObservation
  settled: Promise<void>
  settle: () => void
}

interface ActiveAgentOperation extends ChatGptSubagentCallContext {
  turnId?: string
}

interface SubagentScope {
  agents: Map<string, BrowserAgentState>
  turns: Map<string, BrowserTurnState>
  activeOperations: Map<string, ActiveAgentOperation>
  pendingEvents: string[]
}

export function createChatGptSubagentService(): ChatGptSubagentService {
  const store = createSubagentStore(join(MCP_CONFIG.stateDir, "subagents.sqlite"))
  const scopes = new Map<AgentIdentity | undefined, SubagentScope>()
  const transport: ChatGptSubagentTransport =
    MCP_CONFIG.chatGpt.transport === "extension"
      ? createExtensionSubagentTransport()
      : createPlaywrightSubagentTransport()
  let rateLimitedUntil = 0
  let disposed = false

  const cleanupTimer = setInterval(() => void cleanupIdleAgents(), CLEANUP_INTERVAL_MS)
  cleanupTimer.unref()

  async function askSubagent(request: ChatGptSubagentRequest, callContext: ChatGptSubagentCallContext): Promise<string> {
    const parentAgent = getAgentIdentity()
    const scope = getScope(parentAgent)
    await beginAgentOperation(parentAgent, scope, request.agentId, callContext)
    let agent: BrowserAgentState | undefined
    let operationTransferred = false

    try {
      agent = scope.agents.get(request.agentId)
      if (!agent) {
        const memory = request.memory
        const persisted = memory ? store?.get(parentAgent, request.agentId) : undefined
        agent = {
          agentId: request.agentId,
          kind: persisted?.kind ?? "subagent",
          memory,
          status: "idle",
          lastUsedAt: Date.now(),
          turnCount: persisted?.turnCount ?? 0,
          conversationUrl: persisted?.conversationUrl,
          grants: new Set([
            "reasoning",
            ...(persisted?.grants ?? request.grants),
          ]),
          pendingPermission: persisted?.pendingPermission,
        }
        await ensureAgentPage(scope, agent)
        scope.agents.set(agent.agentId, agent)
      }
      if (agent.pendingPermission) {
        throw new ChatGptSubagentError(
          "AGENT_BUSY",
          `Agent ${agent.agentId} is waiting for Byte to resolve permission request ${agent.pendingPermission.requestId}.`
        )
      }

      let submittedPrompt = request.prompt
      if (agent.turnCount === 0) {
        submittedPrompt = [
          request.prompt,
          "---",
          INJECTED_PROMPT,
          bsapChildPolicy([...agent.grants].sort()),
        ].join("\n\n")
      }
      const turnId = await submitAgentTurn(parentAgent, scope, agent, submittedPrompt)
      operationTransferred = true
      return turnId
    } catch (error) {
      if (!operationTransferred && agent) agent.status = "idle"
      throw error
    } finally {
      if (!operationTransferred) scope.activeOperations.delete(request.agentId)
    }
  }

  async function resolvePermission(
    request: ChatGptPermissionDecisionRequest,
    callContext: ChatGptSubagentCallContext
  ): Promise<string> {
    const parentAgent = getAgentIdentity()
    const scope = getScope(parentAgent)
    let agent = scope.agents.get(request.agentId)

    if (!agent) {
      const persisted = store?.get(parentAgent, request.agentId)
      if (!persisted) {
        throw new ChatGptSubagentError(
          "AGENT_TARGET_LOST",
          `Unknown agent: ${request.agentId}`
        )
      }
      agent = {
        agentId: request.agentId,
        kind: persisted.kind,
        memory: true,
        status: "idle",
        lastUsedAt: Date.now(),
        turnCount: persisted.turnCount,
        conversationUrl: persisted.conversationUrl,
        grants: new Set(["reasoning", ...persisted.grants]),
        pendingPermission: persisted.pendingPermission,
      }
      scope.agents.set(agent.agentId, agent)
    }

    const pending = agent.pendingPermission
    if (!pending || pending.requestId !== request.requestId) {
      throw new ChatGptSubagentError(
        "AGENT_BUSY",
        `Agent ${request.agentId} is not waiting for permission request ${request.requestId}.`
      )
    }

    await beginAgentOperation(parentAgent, scope, request.agentId, callContext)
    let operationTransferred = false
    const alreadyGranted = agent.grants.has(pending.capability)

    try {
      if (request.decision === "grant") {
        agent.grants.add(pending.capability)
      }
      agent.pendingPermission = undefined

      const decisionPrompt = bsapPermissionDecisionPrompt({
        requestId: pending.requestId,
        capability: pending.capability,
        decision: request.decision,
        note: request.note,
      })
      const turnId = await submitAgentTurn(
        parentAgent,
        scope,
        agent,
        decisionPrompt
      )

      persistAgent(parentAgent, agent)
      operationTransferred = true
      return turnId
    } catch (error) {
      if (!operationTransferred && !agent.pendingPermission) {
        agent.pendingPermission = pending
      }
      if (
        request.decision === "grant" &&
        !alreadyGranted &&
        !operationTransferred
      ) {
        agent.grants.delete(pending.capability)
      }
      if (!operationTransferred) {
        agent.status = "idle"
        persistAgent(parentAgent, agent)
      }
      throw error
    } finally {
      if (!operationTransferred) {
        scope.activeOperations.delete(request.agentId)
      }
    }
  }

  async function cloneSelf(request: ChatGptCloneSelfRequest, callContext: ChatGptSubagentCallContext): Promise<string> {
    const { signal } = callContext
    const parentAgent = getAgentIdentity()
    const scope = getScope(parentAgent)
    await beginAgentOperation(parentAgent, scope, request.cloneId, callContext)
    let sourcePage: ChatGptManagedPage | undefined
    let branchPage: ChatGptManagedPage | undefined
    let agent: BrowserAgentState | undefined
    let operationTransferred = false

    try {
      if (!isChatGptUrl(request.sourceConversationUrl)) {
        throw new ChatGptSubagentError("AGENT_TARGET_LOST", "clone_self requires a chatgpt.com conversation URL.")
      }
      if (scope.agents.has(request.cloneId) || store?.get(parentAgent, request.cloneId)) {
        throw new ChatGptSubagentError("AGENT_BUSY", `Clone ${request.cloneId} already exists.`)
      }

      sourcePage = await createManagedPage(signal)
      await transport.navigate(sourcePage, request.sourceConversationUrl, signal)
      await transport.ensureReady(sourcePage, signal)
      if (!transport.forkLatestPage) {
        throw new ChatGptSubagentError(
          "BROWSER_UNAVAILABLE",
          `clone_self is not supported by the ${transport.kind} ChatGPT transport.`
        )
      }
      branchPage = await transport.forkLatestPage(sourcePage, signal)
      if (branchPage !== sourcePage && !sourcePage.isClosed()) {
        await transport.closePage(sourcePage).catch(() => undefined)
      }
      sourcePage = undefined
      agent = {
        agentId: request.cloneId,
        kind: "clone",
        memory: true,
        status: "idle",
        page: branchPage,
        lastUsedAt: Date.now(),
        turnCount: 0,
        grants: new Set(["reasoning"]),
      }
      scope.agents.set(agent.agentId, agent)

      await delay(CLONE_INITIAL_SETTLE_MS, signal)
      const turnId = await submitAgentTurn(parentAgent, scope, agent, request.prompt)
      operationTransferred = true
      return turnId
    } catch (error) {
      if (agent) scope.agents.delete(agent.agentId)
      if (branchPage && !branchPage.isClosed()) await transport.closePage(branchPage).catch(() => undefined)
      if (sourcePage && !sourcePage.isClosed()) await transport.closePage(sourcePage).catch(() => undefined)
      throw error
    } finally {
      if (!operationTransferred) scope.activeOperations.delete(request.cloneId)
    }
  }

  async function cloneRun(request: ChatGptCloneRunRequest, callContext: ChatGptSubagentCallContext): Promise<string> {
    const parentAgent = getAgentIdentity()
    const scope = getScope(parentAgent)
    await beginAgentOperation(parentAgent, scope, request.cloneId, callContext)
    let agent: BrowserAgentState | undefined
    let operationTransferred = false

    try {
      agent = scope.agents.get(request.cloneId)
      if (!agent) {
        const persisted = store?.get(parentAgent, request.cloneId)
        if (!persisted || persisted.kind !== "clone") {
          throw new ChatGptSubagentError("AGENT_TARGET_LOST", `Unknown agent: ${request.cloneId}`)
        }
        agent = {
          agentId: request.cloneId,
          kind: "clone",
          memory: true,
          status: "idle",
          lastUsedAt: Date.now(),
          turnCount: persisted.turnCount,
          conversationUrl: persisted.conversationUrl,
          grants: new Set(["reasoning", ...persisted.grants]),
          pendingPermission: persisted.pendingPermission,
        }
        await ensureAgentPage(scope, agent)
        scope.agents.set(agent.agentId, agent)
      } else if (agent.kind !== "clone") {
        throw new ChatGptSubagentError("AGENT_TARGET_LOST", `${request.cloneId} is not a clone.`)
      }

      const turnId = await submitAgentTurn(parentAgent, scope, agent, request.prompt)
      operationTransferred = true
      return turnId
    } catch (error) {
      if (!operationTransferred && agent) agent.status = "idle"
      throw error
    } finally {
      if (!operationTransferred) scope.activeOperations.delete(request.cloneId)
    }
  }

  async function submitAgentTurn(
    parentAgent: AgentIdentity | undefined,
    scope: SubagentScope,
    agent: BrowserAgentState,
    submittedPrompt: string
  ): Promise<string> {
    const operation = scope.activeOperations.get(agent.agentId)
    if (!operation) throw new ChatGptSubagentError("AGENT_BUSY", `Agent ${agent.agentId} has no active operation.`)
    const signal = operation.signal
    let observation: AssistantResponseObservation | undefined
    try {
      if (agent.lastCompletedAt !== undefined) {
        const remaining = agent.lastCompletedAt + MIN_INTER_TURN_DELAY_MS - Date.now()
        if (remaining > 0) await delay(remaining, signal)
      }
      const page = await ensureAgentPage(scope, agent)
      const turnId = `${agent.agentId}_turn_${agent.turnCount + 1}`
      const settlement = createTurnSettlement()
      const turn: BrowserTurnState = {
        turnId,
        agentId: agent.agentId,
        parentAgent,
        status: "running",
        recoveryAttempted: false,
        lastActivityAt: Date.now(),
        prompt: submittedPrompt,
        settled: settlement.promise,
        settle: settlement.resolve,
      }

      observation = await transport.observeAssistantResponse(page, {
        prompt: submittedPrompt,
        onConversationId:
          agent.kind === "clone"
            ? undefined
            : (conversationId) => bindConversation(parentAgent, agent, conversationId),
        onActivity: (activity) => {
          if (activity) agent.status = activity
          turn.lastActivityAt = Date.now()
        },
      })

      await delay(INTERACTION_DELAY_MS, signal)
      assertAgentPage(page, agent)
      await transport.enterPrompt(page, submittedPrompt, signal)
      await delay(INTERACTION_DELAY_MS, signal)
      assertAgentPage(page, agent)
      await delay(SUBMISSION_GRACE_MS, signal)
      await detectRateLimit()
      await transport.submitTurn(
        page,
        {
          turnId,
          prompt: submittedPrompt,
          expectedConversationId: extractConversationId(agent.conversationUrl ?? ""),
        },
        signal
      )

      if (agent.status === "idle") agent.status = "Working"
      agent.lastUsedAt = Date.now()
      agent.turnCount += 1
      persistAgent(parentAgent, agent)
      turn.observation = observation
      scope.turns.set(turnId, turn)
      operation.turnId = turnId
      operation.signal = undefined
      observation = undefined

      void waitForTurnResponse(turn)
      return turnId
    } catch (error) {
      await observation?.dispose().catch(() => undefined)
      throw error
    }
  }

  async function pollSubagent(turnId: string, waitMs: number, signal?: AbortSignal): Promise<ChatGptSubagentPollResult> {
    const parentAgent = getAgentIdentity()
    const scope = scopes.get(parentAgent)
    const turn = scope?.turns.get(turnId)
    if (!turn) throw new ChatGptSubagentError("UNKNOWN_TURN", `Unknown agent turn: ${turnId}`)
    if (turn.status === "running" && waitMs > 0) {
      let timer: NodeJS.Timeout | undefined
      await waitForPromise(Promise.race([turn.settled, new Promise<void>((resolve) => (timer = setTimeout(resolve, waitMs)))]), signal).finally(() => {
        if (timer) clearTimeout(timer)
      })
    }
    throwIfAborted(signal)
    const agentStatus = scope?.agents.get(turn.agentId)?.status
    const activity = agentStatus === "idle" || agentStatus === "uncertain" ? undefined : agentStatus
    return {
      status: turn.status,
      activity: turn.status === "running" ? activity : undefined,
      activityAgeMs: turn.status === "running" ? Math.max(0, Date.now() - turn.lastActivityAt) : undefined,
      response: turn.response,
      errorCode: turn.errorCode,
      errorMessage: turn.errorMessage,
      permissionRequest: turn.permissionRequest,
    }
  }

  async function ensureAgentPage(
    scope: SubagentScope,
    agent: BrowserAgentState
  ): Promise<ChatGptManagedPage> {
    const signal = scope.activeOperations.get(agent.agentId)?.signal
    throwIfAborted(signal)
    const page = agent.page && !agent.page.isClosed() ? agent.page : undefined
    if (agent.turnCount > 0) captureConversationUrlFromPage(agent)
    if (page && isExpectedAgentPage(page, agent)) return page
    const targetUrl = agent.conversationUrl ?? (agent.turnCount === 0 ? (agent.memory ? CHATGPT_START_URL : TEMPORARY_CHAT_URL) : undefined)
    if (!targetUrl) {
      throw new ChatGptSubagentError("AGENT_TARGET_LOST", `Agent ${agent.agentId} lost its page before its conversation URL was saved.`)
    }

    const created = !page
    const restoredPage = page ?? (await createManagedPage(signal))
    try {
      await transport.navigate(restoredPage, targetUrl, signal)
      await transport.ensureReady(restoredPage, signal)
      assertAgentPage(restoredPage, agent)
      agent.page = restoredPage
      agent.lastUsedAt = Date.now()
      return restoredPage
    } catch (error) {
      if (created && !restoredPage.isClosed()) {
        await transport.closePage(restoredPage).catch(() => undefined)
      }
      throw error
    }
  }

  async function waitForTurnResponse(turn: BrowserTurnState): Promise<void> {
    const observation = turn.observation
    if (!observation) return
    try {
      const result = await observation.response
      if (disposed || turn.status !== "running" || turn.observation !== observation) return
      const agent = scopes.get(turn.parentAgent)?.agents.get(turn.agentId)
      if (!agent) return
      if (agent.kind !== "clone" && result.conversationId) bindConversation(turn.parentAgent, agent, result.conversationId)
      completeTurn(turn, result.text)
    } catch (error) {
      if (disposed || turn.status !== "running" || turn.observation !== observation) return
      await failOrRecoverSubmittedTurn(turn, error)
    }
  }

  async function failOrRecoverSubmittedTurn(turn: BrowserTurnState, originalError: unknown): Promise<void> {
    if (turn.status !== "running") return

    const oldObservation = turn.observation
    turn.observation = undefined
    await oldObservation?.dispose().catch(() => undefined)

    const agent = scopes.get(turn.parentAgent)?.agents.get(turn.agentId)
    if (!agent) {
      failTurn(turn, originalError)
      return
    }

    captureConversationUrlFromPage(agent)

    if (!turn.recoveryAttempted && agent.conversationUrl) {
      turn.recoveryAttempted = true
      turn.lastActivityAt = Date.now()
      agent.status = "Working"
      try {
        if (await recoverSubmittedTurn(turn)) return
      } catch (recoveryError) {
        originalError = recoveryError
      }
    }

    agent.status = "uncertain"
    failTurn(turn, originalError)
  }

  async function recoverSubmittedTurn(turn: BrowserTurnState): Promise<boolean> {
    const agent = scopes.get(turn.parentAgent)?.agents.get(turn.agentId)
    if (!agent) {
      throw new ChatGptSubagentError(
        "AGENT_TARGET_LOST",
        `Agent ${turn.agentId} no longer exists.`
      )
    }

    const conversationUrl = agent.conversationUrl
    const conversationId = conversationUrl
      ? extractConversationId(conversationUrl)
      : undefined
    if (!conversationUrl || !conversationId) {
      throw new ChatGptSubagentError(
        "AGENT_TARGET_LOST",
        `Agent ${agent.agentId} has no saved conversation to recover.`
      )
    }

    if (!transport.recoverSubmittedTurn) return false

    const oldPage = agent.page
    const recovered = await transport.recoverSubmittedTurn(
      oldPage,
      conversationUrl,
      turn.prompt,
      agent.turnCount
    )

    if (recovered.page && recovered.page !== oldPage) {
      agent.page = recovered.page
      agent.lastUsedAt = Date.now()
      if (oldPage && !oldPage.isClosed()) {
        await transport.closePage(oldPage).catch(() => undefined)
      }
    }

    if (!recovered.response) return false
    completeTurn(turn, recovered.response)
    return true
  }

  async function disposeSubagents(): Promise<void> {
    disposed = true
    clearInterval(cleanupTimer)
    const allTurns = [...scopes.values()].flatMap((scope) => [...scope.turns.values()])
    const allAgents = [...scopes.values()].flatMap((scope) => [...scope.agents.values()])
    const observations = allTurns
      .map((turn) => turn.observation)
      .filter(
        (value): value is AssistantResponseObservation => value !== undefined
      )
    const pages = allAgents
      .map((agent) => agent.page)
      .filter(
        (page): page is ChatGptManagedPage =>
          page !== undefined && !page.isClosed()
      )

    for (const turn of allTurns) turn.settle()
    scopes.clear()
    store?.close()

    await Promise.allSettled([
      ...observations.map((observation) => observation.dispose()),
      ...pages.map((page) => transport.closePage(page)),
    ])
    await transport.dispose()
  }

  async function beginAgentOperation(
    parentAgent: AgentIdentity | undefined,
    scope: SubagentScope,
    agentId: string,
    callContext: ChatGptSubagentCallContext
  ): Promise<void> {
    assertNotRateLimited()
    const agent = scope.agents.get(agentId)
    if (scope.activeOperations.has(agentId)) {
      throw new ChatGptSubagentError(
        "AGENT_BUSY",
        `Agent ${agentId} already has an active turn.`
      )
    }
    if (agent?.status === "uncertain") {
      throw new ChatGptSubagentError(
        "AGENT_BUSY",
        `Agent ${agentId} has uncertain upstream state after recovery could not confirm completion. Use another existing agent ID, or a new ID if a delegated-agent slot is available.`
      )
    }
    if (agent && agent.status !== "idle") {
      throw new ChatGptSubagentError(
        "AGENT_BUSY",
        `Agent ${agentId} is still ${agent.status}.`
      )
    }

    assertDelegatedAgentSlotAvailable(parentAgent, scope, agentId)
    const operation: ActiveAgentOperation = { ...callContext }
    scope.activeOperations.set(agentId, operation)

    try {
      const { signal } = callContext
      throwIfAborted(signal)
      await transport.ensureConnected(signal)

      if (rateLimitedUntil > 0) {
        if (Date.now() < rateLimitedUntil) return
        await transport.dismissRateLimit(signal)
        await delay(RATE_LIMIT_DISMISS_SETTLE_MS, signal)
        rateLimitedUntil = 0
        return
      }

      await detectRateLimit()
    } catch (error) {
      if (scope.activeOperations.get(agentId) === operation) {
        scope.activeOperations.delete(agentId)
      }
      throw error
    }
  }

  function completeTurn(turn: BrowserTurnState, response: string): void {
    if (turn.status !== "running") return
    const scope = scopes.get(turn.parentAgent)
    if (!scope) {
      failTurn(
        turn,
        new ChatGptSubagentError(
          "AGENT_TARGET_LOST",
          `Agent ${turn.agentId} no longer exists.`
        )
      )
      return
    }
    const agent = scope.agents.get(turn.agentId)
    if (!agent) {
      failTurn(
        turn,
        new ChatGptSubagentError(
          "AGENT_TARGET_LOST",
          `Agent ${turn.agentId} no longer exists.`
        )
      )
      return
    }

    const now = Date.now()
    captureConversationUrlFromPage(agent)
    agent.lastCompletedAt = now
    agent.lastUsedAt = now
    agent.status = "idle"

    const requested = parseBsapPermissionRequest(response)
    if (requested) {
      const permissionRequest: ChatGptPermissionRequest = {
        requestId: `${turn.turnId}_permission`,
        ...requested,
      }
      agent.pendingPermission = permissionRequest
      turn.status = "permission_required"
      turn.permissionRequest = permissionRequest
      persistAgent(turn.parentAgent, agent)
      settleTurn(turn)
      scope.pendingEvents.push(
        `agent_permission_request agent_id=${turn.agentId} turn_id=${turn.turnId} request_id=${permissionRequest.requestId} capability=${permissionRequest.capability}`
      )
      return
    }

    agent.pendingPermission = undefined
    turn.status = "completed"
    turn.response = response
    persistAgent(turn.parentAgent, agent)
    settleTurn(turn)
    scope.pendingEvents.push(
      `agent_finished agent_id=${turn.agentId} turn_id=${turn.turnId}`
    )
  }

  function drainPendingEvents(): string[] {
    const agent = getAgentIdentity()
    const scope = scopes.get(agent)
    if (!scope || scope.pendingEvents.length === 0) return []
    return scope.pendingEvents.splice(0)
  }

  function failTurn(turn: BrowserTurnState, error: unknown): void {
    if (turn.status !== "running") return
    turn.status = "failed"
    turn.errorCode = error instanceof ChatGptSubagentError ? error.code : "subagent_failed"
    turn.errorMessage = error instanceof Error ? error.message : String(error)
    settleTurn(turn)
  }

  function settleTurn(turn: BrowserTurnState): void {
    void turn.observation?.dispose().catch(() => undefined)
    turn.observation = undefined
    const scope = scopes.get(turn.parentAgent)
    if (scope?.activeOperations.get(turn.agentId)?.turnId === turn.turnId) scope.activeOperations.delete(turn.agentId)
    turn.settle()
  }

  async function createManagedPage(signal?: AbortSignal): Promise<ChatGptManagedPage> {
    await transport.ensureConnected(signal)
    return transport.createPage(signal)
  }

  function assertAgentPage(page: ChatGptManagedPage, agent: BrowserAgentState): void {
    if (isExpectedAgentPage(page, agent)) return
    throw new ChatGptSubagentError("AGENT_TARGET_LOST", `Agent ${agent.agentId} no longer owns a usable ChatGPT page.`)
  }

  function isExpectedAgentPage(page: ChatGptManagedPage, agent: BrowserAgentState): boolean {
    if (page.isClosed() || !isChatGptUrl(page.url())) return false
    const currentConversationId = extractConversationId(page.url())
    const expectedConversationId = agent.conversationUrl ? extractConversationId(agent.conversationUrl) : undefined
    return expectedConversationId ? currentConversationId === expectedConversationId : currentConversationId === undefined
  }

  function bindConversation(parentAgent: AgentIdentity | undefined, agent: BrowserAgentState, conversationId: string): void {
    const pageUrl = agent.page && !agent.page.isClosed() ? agent.page.url() : undefined
    if (pageUrl && extractConversationId(pageUrl) === conversationId) agent.conversationUrl = pageUrl
    else if (extractConversationId(agent.conversationUrl ?? "") !== conversationId) {
      const url = new URL(CHATGPT_START_URL)
      const encodedId = encodeURIComponent(conversationId)
      if (/\/g\/g-p-[^/]+\/project\/?$/.test(url.pathname)) {
        url.pathname = `${url.pathname.replace(/\/project\/?$/, "")}/c/${encodedId}`
        url.search = ""
        url.hash = ""
        agent.conversationUrl = url.toString()
      } else {
        agent.conversationUrl = `https://chatgpt.com/c/${encodedId}`
      }
    }
    persistAgent(parentAgent, agent)
  }

  function captureConversationUrlFromPage(agent: BrowserAgentState): void {
    if (agent.conversationUrl || !agent.page || agent.page.isClosed()) return
    const pageUrl = agent.page.url()
    if (extractConversationId(pageUrl)) agent.conversationUrl = pageUrl
  }

  function persistAgent(parentAgent: AgentIdentity | undefined, agent: BrowserAgentState): void {
    if (!agent.memory || !agent.conversationUrl) return
    store?.set(parentAgent, agent.agentId, {
      conversationUrl: agent.conversationUrl,
      turnCount: agent.turnCount,
      kind: agent.kind,
      grants: [...agent.grants].sort(),
      pendingPermission: agent.pendingPermission,
    })
  }

  function assertDelegatedAgentSlotAvailable(parentAgent: AgentIdentity | undefined, scope: SubagentScope, requestedAgentId: string): void {
    const agents = new Map<string, string | undefined>()

    for (const persisted of store?.list(parentAgent) ?? []) {
      agents.set(persisted.agentId, persisted.turnCount > 0 ? `${persisted.agentId}_turn_${persisted.turnCount}` : undefined)
    }
    for (const agent of scope.agents.values()) {
      const activeTurnId = scope.activeOperations.get(agent.agentId)?.turnId
      agents.set(agent.agentId, activeTurnId ?? (agent.turnCount > 0 ? `${agent.agentId}_turn_${agent.turnCount}` : undefined))
    }
    for (const [agentId, operation] of scope.activeOperations) {
      if (!agents.has(agentId)) agents.set(agentId, operation.turnId)
    }

    if (agents.has(requestedAgentId) || agents.size < MCP_CONFIG.chatGpt.maxDelegatedAgents) return

    const existing = [...agents.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([existingAgentId, turnId]) => `${existingAgentId} (latest_turn_id=${turnId ?? "pending"})`)
      .join(", ")
    throw new ChatGptSubagentError(
      "AGENT_LIMIT_REACHED",
      `This main agent already has the maximum ${MCP_CONFIG.chatGpt.maxDelegatedAgents} delegated agents. Reuse one of these agent IDs: ${existing}.`
    )
  }

  function assertNotRateLimited(): void {
    if (Date.now() >= rateLimitedUntil) return
    throw new ChatGptSubagentError("SUBAGENT_RATE_LIMITED", RATE_LIMIT_ERROR_MESSAGE)
  }

  async function detectRateLimit(): Promise<void> {
    assertNotRateLimited()
    if (!(await transport.detectRateLimit())) return
    rateLimitedUntil = Date.now() + RATE_LIMIT_COOLDOWN_MS
    throw new ChatGptSubagentError(
      "SUBAGENT_RATE_LIMITED",
      RATE_LIMIT_ERROR_MESSAGE
    )
  }

  async function cleanupIdleAgents(): Promise<void> {
    if (disposed) return
    const now = Date.now()
    for (const scope of scopes.values()) {
      for (const agent of scope.agents.values()) {
        const activeOperation = scope.activeOperations.get(agent.agentId)
        const activeTurn = activeOperation?.turnId ? scope.turns.get(activeOperation.turnId) : undefined

        if (activeTurn?.status === "running") {
          if (agent.memory && !activeTurn.recoveryAttempted && now - activeTurn.lastActivityAt >= STALE_TURN_RECOVERY_MS) {
            await failOrRecoverSubmittedTurn(activeTurn, new ChatGptSubagentError("AGENT_IDLE_EXPIRED", "Agent turn had no observable progress for 3 minutes."))
          } else if (now - activeTurn.lastActivityAt >= AGENT_IDLE_TTL_MS) {
            await failOrRecoverSubmittedTurn(
              activeTurn,
              new ChatGptSubagentError("AGENT_IDLE_EXPIRED", "Agent turn expired after 30 minutes without observable progress.")
            )
          }
          continue
        }

        if ((activeOperation && !activeOperation.turnId) || now - agent.lastUsedAt < AGENT_IDLE_TTL_MS) continue
        const page = agent.page
        if (page && !page.isClosed()) {
          await transport.closePage(page).catch(() => undefined)
        }
        if (agent.page === page) agent.page = undefined
      }
    }
  }

  return {
    ask: askSubagent,
    cloneSelf,
    cloneRun,
    poll: pollSubagent,
    resolvePermission,
    drainEvents: drainPendingEvents,
    dispose: disposeSubagents,
  }

  function getScope(parentAgent: AgentIdentity | undefined): SubagentScope {
    const existing = scopes.get(parentAgent)
    if (existing) return existing
    const scope: SubagentScope = {
      agents: new Map(),
      turns: new Map(),
      activeOperations: new Map(),
      pendingEvents: [],
    }
    scopes.set(parentAgent, scope)
    return scope
  }
}

function createTurnSettlement(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
