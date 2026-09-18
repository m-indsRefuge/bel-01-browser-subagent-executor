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

## BEL-01B acceptance target
- existing-profile extension loads in Chrome;
- loopback bridge authenticates extension traffic;
- WSL can `ping` the extension;
- only ChatGPT tabs are listed;
- one inactive ChatGPT tab can be created and read;
- chrome.debugger can attach to that tab;
- sanitized Network/Page events reach WSL;
- no prompt is entered or submitted during this milestone.
