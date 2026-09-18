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
Status: OPEN — next BEL-01 milestone.
Risks include Windows Chrome discovery, localhost reachability, CDP binding, profile ownership, path translation, and process lifecycle.
BEL-01 must prove it is attached to the intended managed Chrome profile before sending a delegated prompt.

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
