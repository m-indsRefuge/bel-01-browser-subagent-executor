# BEL-01 ChatGPT Extension Bridge

This directory contains the BEL-01B proof-of-concept Chrome transport.

It is intentionally narrower than the final BSAP v2 browser executor. The extension:

- runs inside the user's existing authenticated Chrome profile;
- connects only to a loopback BEL-01 bridge;
- accepts a bearer token generated locally by BEL-01;
- lists only `https://chatgpt.com/*` tabs;
- creates only background ChatGPT tabs;
- navigates only within `https://chatgpt.com/`;
- attaches `chrome.debugger` only to ChatGPT tabs;
- forwards only sanitized CDP metadata during BEL-01B.

BEL-01B.1 adds explicit draft-only mutation. BEL-01B.2a adds one separate at-most-once submission
capability for a fresh child tab. Submission requires an exact draft match, a persistent submission
identity, and a uniquely identified visible Send button. It does **not** use Enter as a submission
fallback, read conversation text, expose cookies, forward request headers, or provide arbitrary
browser control.

## 1. Start the bridge in WSL

From the BEL-01 repository:

```bash
node scripts/chrome-extension-bridge.mjs
```

The server binds to `127.0.0.1:9233` and prints a persistent local bearer token.
The token is stored in:

```text
.shellby/chrome-extension-bridge.token
```

The file is local state and is excluded by the repository's existing `.shellby/*` ignore rule.

## 2. Load the unpacked extension

In the existing authenticated Chrome profile:

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Choose **Load unpacked**.
4. Select the Windows-visible copy of this repository's `browser-extension` directory.

For a WSL repository this is normally reachable through:

```text
\\wsl.localhost\Ubuntu\home\<linux-user>\projects\bel-01-browser-subagent-executor\browser-extension
```

Use the actual WSL distribution name shown by `wsl.exe -l -q`.

## 3. Configure the extension

Open the extension's **Options** page.

Set:

- Bridge URL: `http://127.0.0.1:9233`
- Bridge token: the token printed by `chrome-extension-bridge.mjs`
- Enable BEL-01 bridge polling: checked

Save, then choose **Test bridge**.

A successful health response should show:

```json
{
  "ok": true,
  "service": "bel-01-chrome-extension-bridge"
}
```

## 4. Probe from WSL

With the bridge and extension running:

```bash
node scripts/chrome-extension-client.mjs ping
node scripts/chrome-extension-client.mjs list_tabs
```

The second command must return only ChatGPT tabs.

To create one inactive ChatGPT tab:

```bash
node scripts/chrome-extension-client.mjs create_chatgpt_tab
```

Use the returned integer `tab.id` for the next steps:

```bash
node scripts/chrome-extension-client.mjs get_tab '{"tab_id":123}'
node scripts/chrome-extension-client.mjs show_chatgpt_tab '{"tab_id":123}'
node scripts/chrome-extension-client.mjs attach '{"tab_id":123}'
node scripts/chrome-extension-client.mjs inspect_composer '{"tab_id":123}'
```

`show_chatgpt_tab` explicitly activates the validated ChatGPT child tab and focuses its owning
Chrome window for human inspection. It does not navigate or submit anything.

The composer inspection is read-only. It returns structural metadata such as tag, role,
placeholder, data-testid, visibility, and dimensions. It does not read composer contents or
conversation text and does not mutate the page.

## 5. BEL-01B.1 draft-only canary

Use a fresh isolated tab. After `attach` and `inspect_composer` confirm exactly one visible editable
composer, write a harmless canary without submitting it:

```bash
node scripts/chrome-extension-client.mjs write_composer_draft '{"tab_id":123,"text":"BEL-01B.1 draft canary — do not submit"}'
```

The write path validates and focuses one empty visible composer, inserts text through Chrome CDP
`Input.insertText`, waits 750 ms for application reconciliation, then verifies the draft again.
A successful result reports metadata only, including `verified: true`, `submitted: false`,
`stable_after_ms: 750`, and the character count. The command refuses a non-empty composer and
refuses ambiguous visible editor targets.

Visually confirm the text is present and unsent. Then clear it:

```bash
node scripts/chrome-extension-client.mjs clear_composer_draft '{"tab_id":123,"text":"BEL-01B.1 draft canary — do not submit"}'
```

The clear command requires the same expected draft text and refuses to clear changed content. If
the composer is already empty it returns `already_empty: true` without mutating anything. Otherwise it focuses the verified editor, sends browser-native Ctrl/Command+A followed by
Backspace, waits 750 ms, and verifies stable emptiness. Confirm `verified: true`, `submitted: false`, and `composer_empty: true`, then visually
confirm the composer is empty. Do not press Send during this milestone.

## 6. BEL-01B.2a at-most-once submission canary

Use a brand-new isolated ChatGPT tab for the first-turn canary. B.2a intentionally refuses to
submit into an already-bound conversation.

Write and independently verify a harmless prompt first:

```bash
node scripts/chrome-extension-client.mjs write_composer_draft '{"tab_id":123,"text":"Reply with exactly: BEL-01B.2 ACK"}'

node scripts/chrome-extension-client.mjs compare_composer_draft '{"tab_id":123,"text":"Reply with exactly: BEL-01B.2 ACK"}'
```

The comparison must report `exact_match: true`.

Submit once with a unique stable submission ID:

```bash
node scripts/chrome-extension-client.mjs submit_composer_once '{"tab_id":123,"submission_id":"bel01b2-canary-001","text":"Reply with exactly: BEL-01B.2 ACK"}'
```

A successful result should report `status: "bound"`, `at_most_once: true`, the original tab ID,
and a concrete conversation ID/URL.

The extension stores the prompt fingerprint and armed receipt before clicking Send. It does not
store prompt text in the submission ledger.

Do not automatically retry if submission returns an error after arming. Recover using the same
submission ID:

```bash
node scripts/chrome-extension-client.mjs recover_prompt_submission '{"submission_id":"bel01b2-canary-001"}'
```

Recovery only inspects the original ledger/tab for binding. It cannot resend.

After a successful bound receipt, deliberately call `submit_composer_once` again with the same
submission_id. BEL-01 must return the existing bound receipt without clicking Send again.

Then deliberately try a second submission ID on the same child tab:

```bash
node scripts/chrome-extension-client.mjs submit_composer_once '{"tab_id":123,"submission_id":"bel01b2-canary-002","text":"Reply with exactly: BEL-01B.2 ACK"}'
```

BEL-01 must refuse it because B.2a permits only one first-turn submission identity per child tab.

Use `show_chatgpt_tab` for human acceptance and confirm exactly one copy of the user prompt exists.
B.2a binds the conversation but does not yet reconstruct or return the assistant response; that is
BEL-01B.2b.

After attachment, reload or navigate that ChatGPT tab and inspect sanitized events:

```bash
TOKEN="$(cat .shellby/chrome-extension-bridge.token)"
curl -sS \
  -H "Authorization: Bearer $TOKEN" \
  http://127.0.0.1:9233/operator/events
```

Expected event classes include:

- `Network.requestWillBeSent`
- `Network.responseReceived`
- `Network.webSocketCreated`
- WebSocket frame metadata without payload contents
- `Page.frameNavigated`

## Security boundary

BEL-01B deliberately does not expose general-purpose `chrome.debugger.sendCommand` to the
operator. The current command set is allow-listed and every tab operation validates that the
target is a `chatgpt.com` tab.

This is a capability experiment, not a claim that the normal Chrome profile is a security
sandbox. The extension permission itself is powerful. Only load this unpacked extension from
the BEL-01 repository you control.
