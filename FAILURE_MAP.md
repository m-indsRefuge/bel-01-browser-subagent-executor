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
A draft-only capability accidentally sends the message to ChatGPT, or the B.2 submission capability
fires outside its explicit at-most-once contract.

BEL-01B.1 controls:
- write_composer_draft and clear_composer_draft require an explicitly attached ChatGPT tab;
- draft mutation contains no Send click, Enter-key submission, form submit, requestSubmit, or
  conversation-submit endpoint;
- draft results report `submitted: false`.

BEL-01B.2a controls:
- submission is available only through `submit_composer_once`;
- the composer must exactly match the expected prompt;
- the tab must be fresh and not already bound to a conversation;
- a persistent armed receipt is stored before any Send-button click;
- only one visible enabled allow-listed Send button may be clicked;
- there is no Enter-key fallback;
- once a submission identity is armed, recovery may inspect state but never resubmit.

Tests:
- test/chrome-extension-composer-draft.test.ts
- test/chrome-extension-submission.test.ts

## Duplicate prompt submission after uncertain state
Failure symptom:
The operator sees a timeout, worker restart, lost result, or missing conversation binding and
reissues the same logical prompt.

Risk:
ChatGPT receives the prompt more than once even though the operator believed the first attempt had
failed.

Current controls:
- every submission requires a caller-supplied `submission_id`;
- the extension persists an armed ledger record before clicking Send;
- the record stores only the prompt SHA-256 fingerprint, not prompt text;
- reusing the same submission_id is refused unless it is already safely bound, in which case the
  existing receipt is returned;
- after any submission receipt exists, BEL-01B.2a locks that child tab against every second first-turn submission, even under a different submission_id or prompt;
- the ledger is stored in chrome.storage.local so MV3 worker restarts do not erase it;
- `recover_prompt_submission` can bind or report uncertainty but contains no resend path.

Safe recovery:
Use `recover_prompt_submission` with the original submission_id. Never invent a replacement
submission_id for an uncertain prompt.

Do not:
Do not delete or bypass an uncertain ledger receipt merely to retry a submission. Do not reuse an
ambiguous child tab for a different first-turn prompt.

## Submission ledger storage loss
Failure symptom:
The extension is removed, its site/extension storage is cleared, or the Chrome profile is reset
after a submission became armed or uncertain.

Risk:
The persistent at-most-once receipt can be lost, allowing a later caller to mistake the logical
submission for a new one.

Current boundary:
BEL-01B.2a stores submission receipts in `chrome.storage.local`, which survives MV3 service-worker
restarts and normal Chrome restarts but is not an external durable transaction log.

Safe operation:
Do not uninstall the BEL-01 extension, clear its storage, or reset the Chrome profile while an
armed/submitted/uncertain receipt matters. A later BEL-01/Shellby integration should mirror durable
turn identity into WSL/SQLite before this guarantee is treated as profile-independent.

Do not:
Do not interpret missing ledger state after extension-storage loss as proof that no prior submission
occurred.

## Send-button ambiguity
Failure symptom:
Zero or multiple visible enabled elements match the allow-listed Send-button selectors.

Risk:
BEL-01 could click the wrong control after a ChatGPT UI change.

Current control:
`submit_composer_once` refuses unless exactly one visible enabled Send candidate exists and the
candidate passes a center-point `document.elementFromPoint` hit test. The DOM probe returns only
coordinates/metadata; the actual click is delivered through CDP `Input.dispatchMouseEvent`.
Only the fixed selectors in browser-extension/submission.js are allowed and there is no Enter
fallback.

Safe recovery:
Inspect the child tab and update selector tests deliberately. Do not broaden the selector to generic
buttons or aria labels without evidence.

## Submission clicked but conversation binding missing
Failure symptom:
The Send click is observed, but the child tab does not expose a concrete ChatGPT `/c/...`
conversation URL within SUBMISSION_BIND_TIMEOUT_MS.

Risk:
The prompt may have been accepted even though BEL-01 cannot yet bind durable conversation identity.

Current control:
The receipt becomes `uncertain`; automatic resend is forbidden. Recovery only checks the original
tab for a later conversation binding.

Safe recovery:
Run `recover_prompt_submission` with the original submission_id. If the original tab disappeared
or remains unbound, preserve uncertainty and do not retry automatically.

## Submission ledger corruption
Failure symptom:
A chrome.storage.local submission record is malformed or missing required identity fields.

Risk:
Failing open could permit a duplicate prompt submission.

Current control:
Invalid ledger entries cause submission/recovery to fail closed. BEL-01 does not treat malformed
state as if no prior submission existed.

Do not:
Do not clear the ledger automatically on parse/shape errors.

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

## Response observer binding mismatch
Failure symptom:
A response-observation request resolves a conversation payload whose user-turn count, user prompt,
tab binding, or conversation identity does not match the governed submission receipt.

Risk:
BEL-01 could return an assistant message from the wrong conversation or from a later unrelated turn.

Current controls:
- `observe_submission_response` requires an existing `status: "bound"` submission receipt;
- the caller must provide the original prompt text, whose SHA-256 must match the stored prompt
  fingerprint;
- the original child tab must still be attached and its concrete `/c/...` conversation identity
  must match the receipt;
- BEL-01B.2b currently supports only B.2a first-turn conversations and therefore requires exactly
  one user-role message on the current branch;
- that user message must NFKC/whitespace-normalize to the exact governed prompt;
- only an assistant-role message after that prompt with recipient `all`/null and
  `end_turn: true` is accepted.

Safe recovery:
Treat any binding mismatch as a hard failure. Inspect the ledger/tab relationship before changing
the matching rules.

Do not:
Do not fall back to "latest assistant message" without exact prompt and conversation binding.

## Conversation payload fetch / protocol drift
Failure symptom:
The authenticated in-page request to `/backend-api/conversations/<conversation_id>` fails, or the
returned payload no longer contains the expected `mapping` and `current_node` structure.

Risk:
Guessing around a private protocol change could return partial or unrelated content.

Current control:
Fetch errors and payload-shape errors are explicit failures. The observer does not fall back to DOM
scraping, arbitrary CDP response bodies, or broader page extraction.

Tests:
- test/chrome-extension-response-observer.test.ts

Safe recovery:
Capture only the minimum structural evidence needed to update the frozen payload parser, add tests,
then retest. Do not broaden browser read scope as an automatic workaround.

## Response still generating
Failure symptom:
The bound conversation contains the governed user prompt but no final visible assistant turn with
`end_turn: true`.

Current control:
The observer returns `status: "running"`. Each command may wait at most 10 seconds and polls at
250 ms. Repeated observation is read-only and does not submit or mutate the page.

Do not:
Do not treat partial assistant text as a completed response.

## Oversized assistant response
Failure symptom:
A completed assistant response exceeds the bounded response-return limit.

Current control:
BEL-01B.2b returns at most 128,000 characters and explicitly reports
`response_truncated: true`, `response_characters`, and `response_total_characters`.

Risk:
A truncated response is not a complete sub-agent artifact.

Safe recovery:
Treat truncation as incomplete delivery. A future chunk/pagination capability should be added before
large responses are considered fully retrievable.

## Response content persistence
Risk:
Assistant text could become durable browser-extension state even though only turn identity and
verification metadata are needed for recovery.

Current control:
The completed response text is returned to the caller but is not written into the submission ledger.
The ledger stores only response metadata/fingerprint fields alongside the pre-existing submission
receipt.

Do not:
Do not persist full assistant response text in chrome.storage.local without a separate retention
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

- latest focused Chrome-extension bridge/sanitizer/composer test suite: PASS
- latest TypeScript typecheck against native-clear/show-tab revision: PASS

BEL-01B.1 STATUS: COMPLETE


## BEL-01B.2a acceptance target
- focused submission tests and TypeScript typecheck pass;
- the hardened bridge is healthy with empty queues before the canary;
- a fresh isolated ChatGPT child tab is created and attached;
- a harmless prompt is durably written and independently verified before submission;
- `submit_composer_once` stores an armed receipt before any click;
- exactly one allow-listed Send button is clicked once;
- the command binds the child tab to a concrete ChatGPT conversation URL;
- repeating the same submission_id returns or refuses without another click;
- attempting any second first-turn submission on the same child tab is refused;
- `recover_prompt_submission` can return the bound receipt without resubmitting;
- human inspection confirms exactly one user prompt exists in the resulting conversation.

BEL-01B.2b response completion/reconstruction remains out of scope until B.2a is accepted.


## BEL-01B.2a live acceptance receipt
- focused submission tests: PASS
- TypeScript typecheck: PASS
- full regression suite: PASS
- fresh child tab created and attached: PASS
- canary draft independently verified exact at 33/33 characters before submission: PASS
- `submit_composer_once` returned `status: "bound"`: PASS
- bound receipt returned a concrete ChatGPT conversation ID and URL: PASS
- `at_most_once: true` returned by the live submission receipt: PASS
- human visual inspection confirms exactly one user prompt is present in the resulting conversation: PASS
- human visual inspection confirms an assistant response is present beneath that user prompt: PASS

- same submission_id replay returns the existing bound receipt with unchanged armed/clicked/bound timestamps and no additional Send: PASS
- a second first-turn submission identity on the same child tab is refused: PASS
- `recover_prompt_submission` returns the existing bound receipt without resubmitting: PASS
- human visual inspection after guard testing still confirms exactly one user prompt exists: PASS

BEL-01B.2a STATUS: COMPLETE

Next milestone: BEL-01B.2b — response observation and reconstruction. The executor must bind only to
the accepted submitted turn, observe completion without DOM scraping or duplicate sends, and return a
bounded assistant-response receipt.


## BEL-01B.2b acceptance target
- focused response-observer fixtures and the existing extension regression suite pass;
- TypeScript typecheck and full regression suite pass;
- the B.2a bound submission receipt survives extension reload;
- the original bound child tab is reattached explicitly;
- `observe_submission_response` reconstructs the already-visible canary response without DOM
  scraping or a new Send;
- returned conversation identity matches the B.2a receipt;
- returned response text matches the visually observed assistant response;
- repeated response observation is idempotent/read-only and does not create another user turn;
- a mismatched prompt is refused before any response text is returned;
- human visual inspection confirms the conversation still contains exactly one user turn.

BEL-01B.2b is not complete until the live browser result and human acceptance are recorded.


## BEL-01B.2b preflight receipt
- focused Chrome extension suite including response-observer fixtures: PASS
- TypeScript typecheck: PASS
- full regression suite: PASS
- live browser reconstruction not yet accepted

BEL-01B.2b remains OPEN pending live observation against the governed B.2a canary conversation.
