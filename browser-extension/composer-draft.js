import { COMPOSER_SELECTORS } from "./composer-inspection.js"

const MAX_DRAFT_CHARACTERS = 12_000

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

export function buildComposerDraftWriteExpression(text) {
  const validated = validateComposerDraft(text)
  return buildComposerMutationExpression({
    mode: "write",
    textLiteral: JSON.stringify(validated),
  })
}

export function buildComposerDraftClearExpression(expectedText) {
  const validated = validateComposerDraft(expectedText)
  return buildComposerMutationExpression({
    mode: "clear",
    textLiteral: JSON.stringify(validated),
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

function buildComposerMutationExpression({ mode, textLiteral }) {
  const selectors = JSON.stringify(COMPOSER_SELECTORS)

  return `(() => {
    const selectors = ${selectors};
    const mode = ${JSON.stringify(mode)};
    const intendedText = ${textLiteral};
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
        const contenteditable = element.getAttribute("contenteditable") === "true";
        const textarea = tag === "textarea";
        const editable =
          (contenteditable || textarea) &&
          !element.hasAttribute("disabled") &&
          !element.hasAttribute("readonly");

        if (visible && editable) {
          candidates.push({ element, selector });
        }
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
    const currentText = isTextarea ? element.value : (element.innerText || element.textContent || "");
    const normalizedCurrentText = currentText.replace(/\\r\\n/g, "\\n");
    const normalizedIntendedText = intendedText.replace(/\\r\\n/g, "\\n");
    const meaningfulCurrentText = normalizedCurrentText.replace(/\\u200B/g, "").trim();

    if (mode === "write" && meaningfulCurrentText.length !== 0) {
      throw new Error("BEL-01B.1 refuses to overwrite a non-empty composer.");
    }
    if (mode === "clear" && normalizedCurrentText !== normalizedIntendedText) {
      throw new Error("BEL-01B.1 refuses to clear composer content that does not exactly match the expected draft.");
    }

    element.focus();

    if (isTextarea) {
      const prototype = window.HTMLTextAreaElement.prototype;
      const valueSetter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
      if (!valueSetter) throw new Error("Native textarea value setter unavailable.");

      valueSetter.call(element, mode === "write" ? intendedText : "");
      element.dispatchEvent(new InputEvent("input", {
        bubbles: true,
        composed: true,
        inputType: mode === "write" ? "insertText" : "deleteContentBackward",
        data: mode === "write" ? intendedText : null,
      }));
    } else {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(element);
      selection.removeAllRanges();
      selection.addRange(range);

      const command = mode === "write" ? "insertText" : "delete";
      const commandValue = mode === "write" ? intendedText : null;
      const changed = document.execCommand(command, false, commandValue);
      selection.removeAllRanges();

      if (!changed) {
        throw new Error("Browser rejected the composer draft mutation.");
      }
    }

    const observedText = isTextarea ? element.value : (element.innerText || element.textContent || "");
    const expectedText = mode === "write" ? intendedText : "";
    const normalizedObservedText = observedText.replace(/\\r\\n/g, "\\n");
    const normalizedExpectedText = expectedText.replace(/\\r\\n/g, "\\n");
    const composerEmpty = normalizedObservedText.replace(/\\u200B/g, "").trim().length === 0;

    if (mode === "write" && normalizedObservedText !== normalizedExpectedText) {
      throw new Error("Composer draft verification failed.");
    }
    if (mode === "clear" && !composerEmpty) {
      throw new Error("Composer draft clear verification failed.");
    }

    return {
      mode,
      selector_hint: selector,
      tag,
      characters_written: mode === "write" ? intendedText.length : 0,
      composer_empty: composerEmpty,
      verified: true,
      submitted: false,
    };
  })()`
}

export { MAX_DRAFT_CHARACTERS }
