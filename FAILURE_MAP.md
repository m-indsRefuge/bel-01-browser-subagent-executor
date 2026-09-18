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

## Bridge command timeout race
Failure symptom:
The operator CLI times out or appears to fail while the extension reconnects, and a queued command
may otherwise remain available for later delivery.

Cause:
The original BEL-01B bridge used a 20-second extension long poll while the operator CLI also stopped
waiting after roughly 20 seconds. That created a timing race around MV3 service-worker suspension,
poll rollover, or temporary extension reconnects.

Risk:
A command that the operator believes failed could execute later. This is unacceptable for browser
mutation commands and would be especially dangerous for future submit actions.

Current controls:
- extension long-poll interval reduced to 10 seconds;
- operator waits up to 60 seconds for an explicit result;
- queued commands expire after 45 seconds by default;
- the bridge converts expired queued commands into explicit failed results instead of delivering them;
- the extension independently refuses any command whose expiry timestamp has passed;
- timeout errors include bridge health metadata for diagnosis.

Environment overrides:
- BEL01_BRIDGE_LONG_POLL_MS
- BEL01_BRIDGE_COMMAND_TTL_MS
- BEL01_BRIDGE_WAIT_MS
- BEL01_BRIDGE_RESULT_POLL_MS

Tests:
- test/chrome-extension-bridge.test.ts

Do not:
Do not automatically retry a timed-out mutation command unless its prior command result is known to
be expired or rejected. Future submit capability requires an even stronger at-most-once execution
contract.

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

## Child tab not visible to operator
Failure symptom:
BEL-01 successfully creates and controls a ChatGPT child tab, but the operator cannot find or
visually inspect it.

Cause:
Child tabs are intentionally created with `active: false`. Chrome may place the inactive tab in a
different currently open browser window or outside the visible portion of a crowded tab strip.

Current control:
The explicit `show_chatgpt_tab` command first revalidates the tab as a ChatGPT tab, then activates
that tab and focuses its owning Chrome window. It does not navigate or submit anything.

Do not:
Do not scan or activate arbitrary tabs to locate the child.

## Ephemeral Chrome tab identity
Failure symptom:
A command returns `No tab with id: <tab_id>` even though that tab ID was valid earlier in the
milestone.

Cause:
Chrome tab IDs are runtime identities. If the tab is closed, replaced, or otherwise removed, the
previous ID is no longer valid.

Observed during BEL-01B.1:
The draft-write canary targeted tab 709320461 after that tab had ceased to exist. BEL-01 rejected
the operation before any page mutation occurred.

Safe recovery:
Do not reuse or guess a replacement tab ID. Create a fresh inactive ChatGPT tab, capture its returned
ID, attach it explicitly, inspect the composer, then continue.

Do not:
Do not silently retarget an operation to another ChatGPT tab when the intended tab ID disappears.

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

## Composer draft overwrite / unsafe clear
Failure symptom:
A draft-write command targets a composer that already contains meaningful user text, or a clear
command targets text that no longer matches the BEL-01 draft.

Current controls:
BEL-01B.1 refuses to overwrite a non-empty composer. Empty editor placeholder artifacts such as
zero-width characters are ignored when deciding whether the composer is meaningfully empty.
Clearing requires the caller to provide the expected draft text, and BEL-01 refuses to clear unless
the current composer still exactly matches that expected draft after newline normalization.

Do not:
Do not add an overwrite flag or unconditional clear command to this milestone.

## Draft clear selection lost across CDP boundary
Failure symptom:
The expected draft compares exactly before clearing, but a DOM-selected Backspace clear does not
remain empty after the reconciliation delay.

Observed during BEL-01B.1:
The canary compared exactly at 38/38 characters, but the first clear implementation failed its
post-clear stability check.

Cause:
The original clear path created the selection through Runtime.evaluate, then sent Backspace in a
separate CDP input command. Editor selection/focus state can be altered between those mechanisms.

Current control:
The clear path still requires an exact expected-draft precheck and validated composer focus, but
selection and deletion are now both browser-native input operations: platform-appropriate
Ctrl/Command+A followed by Backspace. The operation then waits for reconciliation and verifies the
composer is empty.

Do not:
Do not weaken the exact-draft precheck to compensate for a selection failure.

## Transient DOM mutation lost to framework reconciliation
Failure symptom:
A draft-write command reports immediate success, but a later metadata comparison shows the composer
is empty.

Observed during BEL-01B.1:
The first DOM-based write path appeared to succeed immediately, but a later comparison on the same
tab reported current_length=0 while expected_length=38.

Cause:
Direct DOM/editor mutation can diverge from ChatGPT's application state. React may reconcile the
editor back to its authoritative empty state after the immediate check.

Current control:
BEL-01B.1 no longer uses direct DOM text mutation for writes. It validates and focuses exactly one
empty visible composer, uses Chrome CDP Input.insertText, waits DRAFT_STABILIZATION_MS, then performs
a metadata-only comparison. A write is accepted only if it remains stable after reconciliation.

Clear behavior:
A clear operation first verifies the exact expected draft. If already empty, it succeeds
idempotently without mutation. Otherwise it focuses the validated composer and uses browser-native
Ctrl/Command+A followed by Backspace through CDP input events, then waits and verifies emptiness.

Do not:
Do not accept immediate DOM equality as proof that the application has adopted the draft state.

## Composer draft partial mutation / uncertain state
Failure symptom:
The browser mutates the composer but subsequent verification fails or Runtime.evaluate returns an
exception after mutation began, or an exact-match clear refuses text that appears visually identical.

Risk:
The caller may not know whether some or all draft text is now present, and contenteditable editors
may normalize line endings, non-breaking spaces, zero-width characters, or trailing newlines after
framework re-render.

Current controls:
The write command verifies the post-mutation text without returning it. A failed write must not be
automatically retried. The metadata-only `compare_composer_draft` probe reports lengths, exact and
canonical match flags, first-difference index, and counts of benign normalization characters without
returning composer text.

Safe recovery:
Run `compare_composer_draft` against the same expected draft before changing the clear policy.
Only widen matching rules when the observed difference is explicitly understood and tested.

Do not:
Do not treat a failed write as proof that no mutation occurred. Do not weaken exact-match clearing
based on visual similarity alone.

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

## Generated Runtime.evaluate escape drift
Failure symptom:
A generated composer mutation expression passes module parsing/tests but fails inside
Runtime.evaluate with a syntax error or malformed regular expression.

Cause:
The browser module generates JavaScript inside a JavaScript template literal, so regex/string
escape sequences require an additional escaping layer.

Current control:
Focused draft tests assert that generated expressions preserve literal \\u200B and \\r\\n
escapes before Chrome execution.

Tests:
- test/chrome-extension-composer-draft.test.ts

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

## BEL-01B.1 live acceptance receipt
- hardened bridge health is clean with extension_connected=true and empty command/result queues: PASS
- three consecutive authenticated bridge ping round-trips: PASS
- one fresh isolated ChatGPT tab is created and attached: PASS
- exactly one visible editable composer is selected: PASS
- canary draft inserted through CDP Input.insertText without submission: PASS
- draft remains present after DRAFT_STABILIZATION_MS with verified=true: PASS
- independent comparison reports current_length=38, expected_length=38, exact_match=true,
  newline_normalized_match=true, and canonical_match=true: PASS
- explicit show_chatgpt_tab reveals the child tab for human inspection: PASS
- human visual inspection confirms the canary is present and unsent: PASS
- revised clear_composer_draft removes the exact expected canary: PASS
- human visual inspection confirms the composer is empty after clear: PASS
- submitted remains false throughout the observed workflow: PASS

Final BEL-01B.1 milestone closure still requires the focused composer-draft tests and TypeScript
typecheck to be rerun against the latest native-clear/show-tab revision.
