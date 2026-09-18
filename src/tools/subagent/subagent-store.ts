import { mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { DatabaseSync } from "node:sqlite"

import type { AgentIdentity } from "../../server/agent-context.js"
import type { ChatGptPermissionRequest } from "./chatgpt-subagent-contracts.js"

export interface PersistedSubagent {
  conversationUrl: string
  turnCount: number
  kind: "subagent" | "clone"
  grants: string[]
  pendingPermission?: ChatGptPermissionRequest
}

export interface PersistedSubagentEntry extends PersistedSubagent {
  agentId: string
}

export interface SubagentStore {
  get(parentAgent: AgentIdentity | undefined, agentId: string): PersistedSubagent | undefined
  list(parentAgent: AgentIdentity | undefined): PersistedSubagentEntry[]
  set(parentAgent: AgentIdentity | undefined, agentId: string, value: PersistedSubagent): void
  close(): void
}

export function createSubagentStore(path: string): SubagentStore | undefined {
  try {
    mkdirSync(dirname(path), { recursive: true })
    const db = new DatabaseSync(path)
    db.exec(`
      CREATE TABLE IF NOT EXISTS agents (
        parent_session_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        conversation_url TEXT NOT NULL,
        turn_count INTEGER NOT NULL,
        kind TEXT NOT NULL DEFAULT 'subagent',
        grants_json TEXT NOT NULL DEFAULT '[]',
        pending_permission_json TEXT,
        PRIMARY KEY (parent_session_id, agent_id)
      )
    `)
    try {
      db.exec("ALTER TABLE agents ADD COLUMN grants_json TEXT NOT NULL DEFAULT '[]'")
    } catch {}
    try {
      db.exec("ALTER TABLE agents ADD COLUMN pending_permission_json TEXT")
    } catch {}

    const get = db.prepare(
      "SELECT conversation_url, turn_count, kind, grants_json, pending_permission_json FROM agents WHERE parent_session_id = ? AND agent_id = ?"
    )
    const list = db.prepare(
      "SELECT agent_id, conversation_url, turn_count, kind, grants_json, pending_permission_json FROM agents WHERE parent_session_id = ? ORDER BY agent_id"
    )
    const set = db.prepare(`
      INSERT INTO agents (
        parent_session_id,
        agent_id,
        conversation_url,
        turn_count,
        kind,
        grants_json,
        pending_permission_json
      )
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(parent_session_id, agent_id) DO UPDATE SET
        conversation_url = excluded.conversation_url,
        turn_count = excluded.turn_count,
        kind = excluded.kind,
        grants_json = excluded.grants_json,
        pending_permission_json = excluded.pending_permission_json
    `)

    return {
      get(parentAgent, agentId) {
        try {
          const row = get.get(parentAgent?.sessionId ?? "", agentId) as
            | {
                conversation_url?: unknown
                turn_count?: unknown
                kind?: unknown
                grants_json?: unknown
                pending_permission_json?: unknown
              }
            | undefined
          if (!row || typeof row.conversation_url !== "string" || typeof row.turn_count !== "number") return undefined
          return {
            conversationUrl: row.conversation_url,
            turnCount: row.turn_count,
            kind: row.kind === "clone" ? "clone" : "subagent",
            grants: parseStringArray(row.grants_json),
            pendingPermission: parsePermission(row.pending_permission_json),
          }
        } catch {
          return undefined
        }
      },
      list(parentAgent) {
        try {
          const rows = list.all(parentAgent?.sessionId ?? "") as Array<{
            agent_id?: unknown
            conversation_url?: unknown
            turn_count?: unknown
            kind?: unknown
            grants_json?: unknown
            pending_permission_json?: unknown
          }>
          return rows.flatMap((row) => {
            if (typeof row.agent_id !== "string" || typeof row.conversation_url !== "string" || typeof row.turn_count !== "number") return []
            return [
              {
                agentId: row.agent_id,
                conversationUrl: row.conversation_url,
                turnCount: row.turn_count,
                kind: row.kind === "clone" ? "clone" : "subagent",
                grants: parseStringArray(row.grants_json),
                pendingPermission: parsePermission(row.pending_permission_json),
              } satisfies PersistedSubagentEntry,
            ]
          })
        } catch {
          return []
        }
      },
      set(parentAgent, agentId, value) {
        try {
          set.run(
            parentAgent?.sessionId ?? "",
            agentId,
            value.conversationUrl,
            value.turnCount,
            value.kind,
            JSON.stringify(value.grants),
            value.pendingPermission ? JSON.stringify(value.pendingPermission) : null
          )
        } catch {
          // Persistence is best effort. Runtime behavior should continue normally.
        }
      },
      close() {
        try {
          db.close()
        } catch {
          // Best effort.
        }
      },
    }
  } catch {
    return undefined
  }
}


function parseStringArray(value: unknown): string[] {
  if (typeof value !== "string") return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : []
  } catch {
    return []
  }
}

function parsePermission(value: unknown): ChatGptPermissionRequest | undefined {
  if (typeof value !== "string" || !value) return undefined
  try {
    const parsed = JSON.parse(value)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined
    const record = parsed as Record<string, unknown>
    if (
      typeof record.requestId !== "string" ||
      typeof record.capability !== "string" ||
      typeof record.reason !== "string"
    ) {
      return undefined
    }
    return {
      requestId: record.requestId,
      capability: record.capability,
      reason: record.reason,
      ...(typeof record.scope === "string" ? { scope: record.scope } : {}),
    }
  } catch {
    return undefined
  }
}
