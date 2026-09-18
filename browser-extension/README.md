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

It does **not** type into ChatGPT, submit prompts, expose cookies, forward request headers,
or provide arbitrary browser control in this milestone.

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
node scripts/chrome-extension-client.mjs attach '{"tab_id":123}'
```

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
