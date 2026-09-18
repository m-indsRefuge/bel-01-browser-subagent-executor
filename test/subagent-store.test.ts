import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import type { AgentIdentity } from "../src/server/agent-context.js"
import { createSubagentStore } from "../src/tools/subagent/subagent-store.js"

test("persists subagent conversation state across store reopen", () => {
  const directory = mkdtempSync(join(tmpdir(), "shellby-subagents-"))
  const path = join(directory, "subagents.sqlite")
  const mainA: AgentIdentity = { sessionId: "main-session-a", agent: "agent-1" }
  const mainB: AgentIdentity = { sessionId: "main-session-b", agent: "agent-2" }
  try {
    const first = createSubagentStore(path)
    assert.ok(first)
    first.set(mainA, "reviewer", {
      conversationUrl: "https://chatgpt.com/c/example-a",
      turnCount: 4,
      kind: "subagent",
      grants: ["reasoning", "web"],
      pendingPermission: {
        requestId: "reviewer_turn_4_permission",
        capability: "shell.write",
        reason: "Need to edit the target file",
        scope: "src/example.ts",
      },
    })
    first.set(mainA, "clone-a", {
      conversationUrl: "https://chatgpt.com/c/clone-a",
      turnCount: 1,
      kind: "clone",
      grants: ["reasoning"],
    })
    first.set(mainB, "reviewer", {
      conversationUrl: "https://chatgpt.com/c/example-b",
      turnCount: 2,
      kind: "subagent",
      grants: ["reasoning"],
    })
    assert.deepEqual(first.list(mainA), [
      {
        agentId: "clone-a",
        conversationUrl: "https://chatgpt.com/c/clone-a",
        turnCount: 1,
        kind: "clone",
        grants: ["reasoning"],
        pendingPermission: undefined,
      },
      {
        agentId: "reviewer",
        conversationUrl: "https://chatgpt.com/c/example-a",
        turnCount: 4,
        kind: "subagent",
        grants: ["reasoning", "web"],
        pendingPermission: {
          requestId: "reviewer_turn_4_permission",
          capability: "shell.write",
          reason: "Need to edit the target file",
          scope: "src/example.ts",
        },
      },
    ])
    first.close()

    const second = createSubagentStore(path)
    assert.ok(second)
    assert.deepEqual(second.get(mainA, "reviewer"), {
      conversationUrl: "https://chatgpt.com/c/example-a",
      turnCount: 4,
      kind: "subagent",
      grants: ["reasoning", "web"],
      pendingPermission: {
        requestId: "reviewer_turn_4_permission",
        capability: "shell.write",
        reason: "Need to edit the target file",
        scope: "src/example.ts",
      },
    })
    assert.deepEqual(second.get(mainB, "reviewer"), {
      conversationUrl: "https://chatgpt.com/c/example-b",
      turnCount: 2,
      kind: "subagent",
      grants: ["reasoning"],
      pendingPermission: undefined,
    })
    assert.deepEqual(
      second.list(mainB).map((agent) => agent.agentId),
      ["reviewer"]
    )
    second.close()
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
