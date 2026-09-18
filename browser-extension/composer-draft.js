import { COMPOSER_SELECTORS } from "./composer-inspection.js"

const MAX_DRAFT_CHARACTERS = 12_000
const DRAFT_STABILIZATION_MS = 750

export function validateComposerDraft(text) {
  if (typeof text !== "string") {
    throw new TypeError("text must be a string.")
  }
  if (text.length === 0) {
    throw new Error("text must not be empty.")
  }
  if (text.length > MAX_DRAFT_CHARACTERS) {
    throw new Error(`text exceeds the ${MAX_DRAFT_CHARACTERS}-character BEL-01B.1 limit.`)
  }
  return text
}

export function buildComposerDraftPrepareWriteExpression() {
  return buildComposerTargetExpression({
    expectedLiteral: "null",
    requireEmpty: true,
    selectAll: false,
  })
}

export function buildComposerDraftPrepareClearExpression(expectedText) {
  const validated = validateComposerDraft(expectedText)
  return buildComposerTargetExpression({
    expectedLiteral: JSON.stringify(validated),
    requireEmpty: false,
    selectAll: true,
  })
}

export function buildComposerDraftCompareExpression(expectedText) {
  const validated = validateComposerDraft(expectedText)
  const selectors = JSON.stringify(COMPOSER_SELECTORS)
  const expectedLiteral = JSON.stringify(validated)

  return `(() => {
    const selectors = ${selectors};
    const expectedText = ${expectedLiteral};
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

        const tag = element.tagName.toLowerCase();
        const editable =
          (element.getAttribute("contenteditable") === "true" || tag === "textarea") &&
          !element.hasAttribute("disabled") &&
          !element.hasAttribute("readonly");

        if (visible && editable) candidates.push({ element, selector });
      }
    }

    if (candidates.length !== 1) {
      throw new Error(
        "BEL-01B.1 requires exactly one visible editable composer; found " + candidates.length + "."
      );
    }

    const { element, selector } = candidates[0];
    const tag = element.tagName.toLowerCase();
    const currentText =
      tag === "textarea" ? element.value : (element.innerText || element.textContent || "");

    const normalizeNewlines = (value) => value.replace(/\\r\\n/g, "\\n");
    const canonicalize = (value) =>
      normalizeNewlines(value)
        .normalize("NFC")
        .replace(/\\u00A0/g, " ")
        .replace(/[\\u200B\\u200C\\u200D\\uFEFF]/g, "")
        .replace(/\\n+$/g, "");

    const normalizedCurrent = normalizeNewlines(currentText);
    const normalizedExpected = normalizeNewlines(expectedText);
    const canonicalCurrent = canonicalize(currentText);
    const canonicalExpected = canonicalize(expectedText);

    let firstDifferenceIndex = -1;
    const limit = Math.min(normalizedCurrent.length, normalizedExpected.length);
    for (let index = 0; index < limit; index += 1) {
      if (normalizedCurrent[index] !== normalizedExpected[index]) {
        firstDifferenceIndex = index;
        break;
      }
    }
    if (firstDifferenceIndex === -1 && normalizedCurrent.length !== normalizedExpected.length) {
      firstDifferenceIndex = limit;
    }

    const countMatches = (value, expression) => (value.match(expression) || []).length;

    return {
      selector_hint: selector,
      tag,
      current_length: currentText.length,
      expected_length: expectedText.length,
      normalized_current_length: normalizedCurrent.length,
      normalized_expected_length: normalizedExpected.length,
      exact_match: currentText === expectedText,
      newline_normalized_match: normalizedCurrent === normalizedExpected,
      canonical_match: canonicalCurrent === canonicalExpected,
      first_difference_index: firstDifferenceIndex,
      zero_width_count: countMatches(currentText, /[\\u200B\\u200C\\u200D\\uFEFF]/g),
      nbsp_count: countMatches(currentText, /\\u00A0/g),
      crlf_count: countMatches(currentText, /\\r\\n/g),
      trailing_newline_count: (normalizedCurrent.match(/\\n+$/) || [""])[0].length,
      submitted: false,
    };
  })()`
}

function buildComposerTargetExpression({ expectedLiteral, requireEmpty, selectAll }) {
  const selectors = JSON.stringify(COMPOSER_SELECTORS)

  return `(() => {
    const selectors = ${selectors};
    const expectedText = ${expectedLiteral};
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

        const tag = element.tagName.toLowerCase();
        const editable =
          (element.getAttribute("contenteditable") === "true" || tag === "textarea") &&
          !element.hasAttribute("disabled") &&
          !element.hasAttribute("readonly");

        if (visible && editable) candidates.push({ element, selector });
      }
    }

    if (candidates.length !== 1) {
      throw new Error(
        "BEL-01B.1 requires exactly one visible editable composer; found " + candidates.length + "."
      );
    }

    const { element, selector } = candidates[0];
    const tag = element.tagName.toLowerCase();
    const isTextarea = tag === "textarea";
    const currentText =
      isTextarea ? element.value : (element.innerText || element.textContent || "");
    const normalizeNewlines = (value) => value.replace(/\\r\\n/g, "\\n");
    const normalizedCurrent = normalizeNewlines(currentText);
    const meaningfulCurrent = normalizedCurrent
      .replace(/[\\u200B\\u200C\\u200D\\uFEFF]/g, "")
      .trim();

    if (${JSON.stringify(requireEmpty)} && meaningfulCurrent.length !== 0) {
      throw new Error("BEL-01B.1 refuses to overwrite a non-empty composer.");
    }

    if (!${JSON.stringify(requireEmpty)} && normalizedCurrent !== normalizeNewlines(expectedText)) {
      throw new Error(
        "BEL-01B.1 refuses to clear composer content that does not exactly match the expected draft."
      );
    }

    element.focus();

    if (${JSON.stringify(selectAll)}) {
      if (isTextarea) {
        element.setSelectionRange(0, element.value.length);
      } else {
        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(element);
        selection.removeAllRanges();
        selection.addRange(range);
      }
    }

    return {
      selector_hint: selector,
      tag,
      current_length: currentText.length,
      focused: document.activeElement === element,
      selection_prepared: ${JSON.stringify(selectAll)},
      submitted: false,
    };
  })()`
}

export { DRAFT_STABILIZATION_MS, MAX_DRAFT_CHARACTERS }
