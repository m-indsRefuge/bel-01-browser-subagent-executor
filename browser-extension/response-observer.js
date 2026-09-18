const RESPONSE_POLL_MAX_WAIT_MS = 10_000
const RESPONSE_POLL_INTERVAL_MS = 250
const MAX_RESPONSE_CHARACTERS = 128_000

export function validateResponseWaitMs(value) {
  if (value === undefined) return 0
  if (!Number.isInteger(value) || value < 0 || value > RESPONSE_POLL_MAX_WAIT_MS) {
    throw new Error(`wait_ms must be an integer between 0 and ${RESPONSE_POLL_MAX_WAIT_MS}.`)
  }
  return value
}

export function buildConversationSnapshotExpression(
  conversationId,
  expectedPrompt,
  maxResponseCharacters = MAX_RESPONSE_CHARACTERS
) {
  if (typeof conversationId !== "string" || conversationId.length === 0) {
    throw new Error("conversation_id is required.")
  }
  if (typeof expectedPrompt !== "string" || expectedPrompt.length === 0) {
    throw new Error("expected prompt is required.")
  }
  if (!Number.isInteger(maxResponseCharacters) || maxResponseCharacters < 1) {
    throw new Error("maxResponseCharacters must be a positive integer.")
  }

  const conversationIdJson = JSON.stringify(conversationId)
  const expectedPromptJson = JSON.stringify(expectedPrompt)
  const maxResponseCharactersJson = JSON.stringify(maxResponseCharacters)

  return `(async () => {
    const conversationId = ${conversationIdJson};
    const expectedPrompt = ${expectedPromptJson};
    const maxResponseCharacters = ${maxResponseCharactersJson};

    const normalizePrompt = (text) =>
      String(text ?? "").normalize("NFKC").replace(/\\s+/g, " ").trim();

    const asRecord = (value) =>
      value && typeof value === "object" && !Array.isArray(value) ? value : undefined;

    const messageText = (message) => {
      const content = asRecord(message?.content);
      if (!content) return "";
      if (Array.isArray(content.parts)) {
        return content.parts.filter((part) => typeof part === "string").join("\\n");
      }
      return typeof content.text === "string" ? content.text : "";
    };

    const normalizeMessage = (value) => {
      const message = asRecord(value);
      const author = asRecord(message?.author);
      const role = typeof author?.role === "string" ? author.role : undefined;
      if (role !== "user" && role !== "assistant") return undefined;

      return {
        role,
        text: messageText(message),
        end_turn: message?.end_turn === true,
        status: typeof message?.status === "string" ? message.status : undefined,
        recipient:
          typeof message?.recipient === "string" || message?.recipient === null
            ? message.recipient
            : undefined,
      };
    };

    const response = await fetch(
      "/backend-api/conversations/" + encodeURIComponent(conversationId),
      {
        method: "GET",
        credentials: "include",
        cache: "no-store",
        headers: { Accept: "application/json" },
      }
    );

    if (!response.ok) {
      return {
        status: "fetch_error",
        http_status: response.status,
        conversation_id: conversationId,
      };
    }

    const payload = await response.json();
    const mapping = asRecord(payload?.mapping);
    const currentNode = typeof payload?.current_node === "string" ? payload.current_node : undefined;

    if (!mapping || !currentNode) {
      return {
        status: "protocol_error",
        reason: "conversation payload is missing mapping/current_node",
        conversation_id: conversationId,
      };
    }

    const nodes = [];
    const seen = new Set();
    let nodeId = currentNode;

    while (nodeId && !seen.has(nodeId)) {
      seen.add(nodeId);
      const node = asRecord(mapping[nodeId]);
      if (!node) break;
      nodes.push(node);
      nodeId = typeof node.parent === "string" ? node.parent : undefined;
    }

    const messages = nodes
      .reverse()
      .map((node) => normalizeMessage(node.message))
      .filter(Boolean);

    const userMessages = messages.filter((message) => message.role === "user");
    if (userMessages.length !== 1) {
      return {
        status: "binding_mismatch",
        reason: "user_turn_count",
        user_turn_count: userMessages.length,
        conversation_id: conversationId,
      };
    }

    const userMessage = userMessages[0];
    if (normalizePrompt(userMessage.text) !== normalizePrompt(expectedPrompt)) {
      return {
        status: "binding_mismatch",
        reason: "prompt_mismatch",
        user_turn_count: 1,
        conversation_id: conversationId,
      };
    }

    const userIndex = messages.indexOf(userMessage);
    let assistant;

    for (let index = messages.length - 1; index > userIndex; index -= 1) {
      const candidate = messages[index];
      if (candidate?.role !== "assistant") continue;
      if (candidate.recipient && candidate.recipient !== "all") continue;
      assistant = candidate;
      break;
    }

    if (!assistant || !assistant.end_turn || !assistant.text) {
      return {
        status: "running",
        user_turn_count: 1,
        conversation_id: conversationId,
      };
    }

    const totalCharacters = assistant.text.length;
    const truncated = totalCharacters > maxResponseCharacters;
    const text = truncated
      ? assistant.text.slice(0, maxResponseCharacters)
      : assistant.text;

    return {
      status: "completed",
      conversation_id: conversationId,
      user_turn_count: 1,
      assistant_status: assistant.status,
      response: text,
      response_characters: text.length,
      response_total_characters: totalCharacters,
      response_truncated: truncated,
    };
  })()`
}

export {
  MAX_RESPONSE_CHARACTERS,
  RESPONSE_POLL_INTERVAL_MS,
  RESPONSE_POLL_MAX_WAIT_MS,
}
