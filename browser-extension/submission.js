const SUBMISSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const SUBMISSION_LEDGER_PREFIX = "bel01_submission:"
const SUBMISSION_BIND_TIMEOUT_MS = 15_000

const SEND_BUTTON_SELECTORS = [
  'button[data-testid="send-button"]',
  'button[aria-label="Send prompt"]',
  'button[aria-label="Send"]',
]

export function validateSubmissionId(value) {
  if (typeof value !== "string" || !SUBMISSION_ID_PATTERN.test(value)) {
    throw new Error(
      "submission_id must be 1-128 characters using letters, numbers, dot, underscore, colon, or hyphen."
    )
  }
  return value
}

export function submissionStorageKey(submissionId) {
  return `${SUBMISSION_LEDGER_PREFIX}${validateSubmissionId(submissionId)}`
}

export function buildSubmitButtonProbeExpression() {
  const selectors = JSON.stringify(SEND_BUTTON_SELECTORS)

  return `(() => {
    const selectors = ${selectors};
    const seen = new Set();
    const candidates = [];

    for (const selector of selectors) {
      for (const element of document.querySelectorAll(selector)) {
        if (seen.has(element)) continue;
        seen.add(element);

        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        const visible =
          rect.width > 0 &&
          rect.height > 0 &&
          style.display !== "none" &&
          style.visibility !== "hidden";
        const enabled =
          !element.hasAttribute("disabled") &&
          element.getAttribute("aria-disabled") !== "true";

        if (visible && enabled) candidates.push({ element, selector });
      }
    }

    if (candidates.length !== 1) {
      throw new Error(
        "BEL-01B.2 requires exactly one visible enabled Send button; found " + candidates.length + "."
      );
    }

    const { element, selector } = candidates[0];
    const rect = element.getBoundingClientRect();

    return {
      click_ready: true,
      selector_hint: selector,
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
      width: rect.width,
      height: rect.height,
      submitted: false,
    };
  })()`
}

export function extractConversationBinding(value) {
  try {
    const url = new URL(value)
    if (url.protocol !== "https:" || url.hostname !== "chatgpt.com") return undefined

    const match = url.pathname.match(/(?:^|\/)c\/([^/?#]+)/)
    const rawConversationId = match?.[1]
    if (!rawConversationId) return undefined

    const conversationId = decodeURIComponent(rawConversationId)
    if (!conversationId || conversationId.toLowerCase().startsWith("web:")) return undefined

    return {
      conversation_id: conversationId,
      conversation_url: `${url.origin}${url.pathname}`,
    }
  } catch {
    return undefined
  }
}

export { SEND_BUTTON_SELECTORS, SUBMISSION_BIND_TIMEOUT_MS, SUBMISSION_LEDGER_PREFIX }
