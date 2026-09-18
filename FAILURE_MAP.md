# BEL-01 Failure Map

Byte Execution Layer — BEL-01 Browser Sub-Agent Executor

## Supported runtime
- macOS arm64
- macOS x64
- Linux / WSL x64
- Computer Use / Peekaboo remains macOS-only.

## Native apply_patch architecture mismatch
Failure symptom: apply_patch exits immediately with an executable-format or shell syntax error.
Observed on WSL when the macOS binary was executed: Syntax error: ")" unexpected.
Diagnosis: inspect the binary with file and compare it with its provenance JSON.
Recovery: rebuild from the pinned OpenAI Codex source using scripts/build-apply-patch.sh.
Risk: a patch may be partially applied after execution begins; partial changes must be reported.
Tests: test/apply-patch-vendor.test.ts and test/integrations/apply-patch.ts.

## Shell runtime mismatch
Failure symptom: zsh-specific syntax errors, unexpected shell loss, or state-recovery failures.
Cause: Shellby persistent shell machinery expects zsh semantics.
Recovery: configure shell.path to a tested zsh executable.

## MCP output mode mismatch
Failure symptom: structured objects appear where compact textual results are expected.
Recovery: use mcp.tool_output = "compact" unless structured output is intentionally under test.

## Peekaboo / Computer Use on WSL
Peekaboo is currently macOS-specific and Computer Use is disabled in the BEL-01 WSL profile.
The Peekaboo vendor test is skipped outside Darwin.

## CDP endpoint collision
Failure symptom: the configured CDP endpoint belongs to another Chrome profile.
Recovery: identify the port owner and use a dedicated BEL-01 Chrome profile and CDP port.
Do not submit a delegated prompt through an ambiguous CDP endpoint.

## Windows Chrome / WSL boundary
Status: SUPERSEDED FOR BEL-01B POC.
The dedicated-profile raw-CDP route remains available for future use, but BEL-01B now tests a
permissioned extension transport inside the user's existing authenticated Chrome profile.

## Existing-profile extension bridge unavailable
Failure symptom: the extension Options page cannot reach http://127.0.0.1:9233, or operator
commands remain pending.

Likely causes:
- the WSL bridge process is not running;
- Windows-to-WSL localhost forwarding is unavailable;
- the extension has an incorrect bearer token;
- extension polling is disabled;
- Chrome suspended or unloaded the extension service worker.

First diagnostics:
- GET http://127.0.0.1:9233/health from WSL;
- use **Test bridge** on the extension Options page;
- compare the extension token with .shellby/chrome-extension-bridge.token;
- inspect chrome://extensions for extension/service-worker errors.

Safe recovery:
Restart the bridge, reload the unpacked extension if needed, verify the token, then retry a
read-only `ping` or `list_tabs` command.

Do not:
- bind the bridge to a non-loopback interface during BEL-01B;
- disable bearer-token authentication;
- expand the extension to arbitrary sites to work around a ChatGPT-tab validation failure.

## Chrome debugger attachment denied
Failure symptom: `attach` returns an error from chrome.debugger.

Likely causes:
- the tab is not a https://chatgpt.com/ tab;
- another debugger owns the tab;
- Chrome rejected or detached the debugger session;
- extension debugger permission is missing.

Safe recovery:
Verify the target tab URL, detach any competing debugger, and retry deliberately. Do not silently
switch to a different tab.

## Extension bridge scope escape
Risk:
A browser bridge attached to the normal Chrome profile is not a security sandbox. A bug that
accepts arbitrary tab IDs or URLs could expose unrelated authenticated browsing state.

Current controls:
- extension host scope includes chatgpt.com and loopback bridge only;
- all tab operations revalidate the target URL;
- navigation is restricted to https://chatgpt.com/;
- there is no generic operator-facing CDP command in BEL-01B;
- forwarded Network/WebSocket events are sanitized and omit payload contents and headers.

Do not:
Broaden the command surface or site scope without an explicit BSAP capability decision and tests.

## Sanitized CDP metadata leaks secrets through URLs
Failure symptom:
The event stream omits request headers and WebSocket payload contents but still contains full URLs
with query strings, signed download parameters, account identifiers, or verification tokens.

Observed during BEL-01B:
The first live sanitized stream included signed file URLs, an account_id query parameter, and a
WebSocket verify token.

Cause:
URL values were forwarded without stripping query strings or identifier-like path segments.

Current control:
All forwarded HTTP/WebSocket URLs are reduced to scheme + host + sanitized pathname. Query strings
and fragments are removed, and UUID/project/file/user-style path identifiers are redacted.

Tests:
- test/chrome-extension-sanitize.test.ts

Do not:
Do not broaden CDP event forwarding or reintroduce raw URLs without explicit redaction tests.

## Composer inspection scope creep
Failure symptom:
A read-only DOM probe begins returning composer contents, conversation text, arbitrary page DOM,
or starts mutating/focusing/clicking elements.

Risk:
The extension could cross from structural detection into content access or interaction before the
BSAP capability boundary has been explicitly widened.

Current control:
The BEL-01B `inspect_composer` command requires an explicitly attached ChatGPT tab and returns only
structural metadata for a small allow-list of composer-shaped selectors. The inspection expression
does not read textContent, innerText, innerHTML, value, or invoke click/focus/dispatchEvent.

Tests:
- test/chrome-extension-composer-inspection.test.ts

Do not:
Do not add typing, submission, arbitrary DOM queries, or conversation-text extraction to this
milestone.

## Stale staged extension build
Failure symptom:
The WSL repository contains a new allow-listed command but Chrome returns
`Unsupported BEL-01 extension command`.

Observed during BEL-01B:
`inspect_composer` was present in WSL source while Chrome was still running the older Windows-staged
copy of the unpacked extension.

Cause:
The unpacked extension is staged on the Windows filesystem and Chrome does not automatically reload
when the WSL source tree changes.

First diagnostics:
- compare the WSL and Windows-staged service-worker.js files;
- verify the expected command string exists in both copies;
- reload the extension in chrome://extensions.

Safe recovery:
Re-copy browser-extension to the Windows staging directory, reload the unpacked extension, then
`ping` and explicitly reattach the intended ChatGPT tab because extension reload clears in-memory
debugger attachment state.

## Composer draft target ambiguity
Failure symptom:
More than one or zero visible editable composer candidates are present.

Observed during BEL-01B:
ChatGPT exposed both a visible contenteditable #prompt-textarea and a hidden zero-size textarea.

Current control:
BEL-01B.1 ignores hidden/non-editable candidates and refuses to mutate unless exactly one visible
editable composer remains.

Do not:
Do not guess which element to write to when target identity is ambiguous.

## Composer draft overwrite
Failure symptom:
A draft-write command targets a composer that already contains meaningful user text.

Current control:
BEL-01B.1 refuses to overwrite a non-empty composer. Empty editor placeholder artifacts such as
zero-width characters are ignored when deciding whether the composer is meaningfully empty.

Do not:
Do not add an overwrite flag to this milestone.

## Composer draft partial mutation / uncertain state
Failure symptom:
The browser mutates the composer but subsequent verification fails or Runtime.evaluate returns an
exception after mutation began.

Risk:
The caller may not know whether some or all draft text is now present.

Current control:
The command verifies the post-mutation text without returning it. A failed write must not be
automatically retried. The next action is inspect the same isolated tab and visually confirm state,
or deliberately clear the composer.

Do not:
Do not treat a failed write as proof that no mutation occurred.

## Accidental prompt submission
Risk:
A draft-only capability accidentally sends the message to ChatGPT.

Current controls:
- write_composer_draft and clear_composer_draft require an explicitly attached ChatGPT tab;
- no click, form submit, requestSubmit, KeyboardEvent, Enter-key synthesis, or conversation-submit
  endpoint is present in the draft mutation expression;
- the result contract reports `submitted: false`;
- draft commands return metadata only, never the draft contents.

Tests:
- test/chrome-extension-composer-draft.test.ts

Do not:
Do not add any submit mechanism to BEL-01B.1. Submission is a separate milestone and capability
decision.

## Browser protocol drift
Symptoms include composer discovery failure, prompt binding failure, response reconstruction failure, or CHATGPT_UI_CHANGED.
Do not automatically resend an uncertain prompt.

## Vendor provenance drift
Verify Codex source commit, architecture, Rust/Cargo versions, and SHA-256 before trusting a rebuilt native artifact.

## BEL-01A verification receipt
- Node 24 runtime: PASS
- Dependency installation: PASS
- TypeScript typecheck: PASS
- Production build: PASS
- Native Linux apply_patch: PASS
- Applicable test suite: PASS
- Computer Use / Peekaboo: intentionally excluded on WSL
- Live Windows Chrome integration: not yet accepted

## BEL-01B verification receipt
- existing-profile extension loads in Chrome: PASS
- loopback bridge authenticates extension traffic: PASS
- WSL can `ping` the extension: PASS
- only ChatGPT tabs are listed: PASS
- one inactive ChatGPT tab can be created and read: PASS
- chrome.debugger can attach to that tab: PASS
- sanitized Network/Page/WebSocket metadata reaches WSL: PASS
- URL query/identifier leakage hardened with focused tests: PASS
- read-only composer discovery finds the visible #prompt-textarea and rejects the hidden textarea: PASS
- no prompt entered or submitted during BEL-01B: PASS

## BEL-01B.1 acceptance target
- focused composer-draft tests and typecheck pass;
- one fresh isolated ChatGPT tab is attached;
- exactly one visible editable composer is selected;
- a canary draft is written without submission;
- returned metadata reports verified=true and submitted=false;
- human visual inspection confirms the canary is present but unsent;
- clear_composer_draft removes the canary;
- human visual inspection confirms the composer is empty and no conversation was created.
