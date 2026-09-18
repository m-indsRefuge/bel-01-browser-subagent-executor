const COMPOSER_SELECTORS = [
  "#prompt-textarea",
  "textarea[data-testid=\"prompt-textarea\"]",
  "[data-testid=\"prompt-textarea\"]",
  "div.ProseMirror[contenteditable=\"true\"]",
  "[contenteditable=\"true\"][role=\"textbox\"]",
  "textarea[placeholder]",
]

export function buildComposerInspectionExpression() {
  const selectors = JSON.stringify(COMPOSER_SELECTORS)

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

        candidates.push({
          selector_hint: selector,
          tag: element.tagName.toLowerCase(),
          id: element.id || null,
          role: element.getAttribute("role"),
          aria_label: element.getAttribute("aria-label"),
          placeholder: element.getAttribute("placeholder"),
          contenteditable: element.getAttribute("contenteditable"),
          data_testid: element.getAttribute("data-testid"),
          visible,
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        });
      }
    }

    return {
      found: candidates.some((candidate) => candidate.visible),
      candidate_count: candidates.length,
      candidates: candidates.slice(0, 10),
    };
  })()`
}

export { COMPOSER_SELECTORS }
