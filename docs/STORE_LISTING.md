# Chrome Web Store listing

## Identity

- **Name:** opencode-chrome
- **Summary (≤132 chars):** Let opencode drive your real Chrome: logged-in sessions, cookies and tabs, through a local MCP bridge. Unofficial, BYOK, no data collected.
- **Category:** Productivity
- **Language:** English (+ Spanish listing optional)
- **Privacy policy URL:** https://github.com/G10hdz/opencode-chrome/blob/main/docs/PRIVACY.md

## Single purpose

Let the local opencode MCP bridge operate the user's own browser tabs
(navigate, read page structure, click, type, screenshot) on the user's
instruction.

## chrome.debugger justification (required by review)

The `debugger` permission powers the tool set the user installs this
extension for: `snapshot` (read DOM as a text tree), `click`/`type`
(interact with resolved elements), `screenshot` (Page.captureScreenshot),
`wait_for` (poll page text), via the Chrome DevTools Protocol. There is no
other way for an extension to read page structure and dispatch trusted
input events. Usage is: attached on demand to the single tab the agent is
acting on, detached automatically after 30s idle. Nothing is sent anywhere
except localhost (127.0.0.1), to the user's own bridge process started by
their own `npx opencode-chrome` command.

## tabs permission justification

`list_tabs`, `new_tab`, `close_tab`, `activate_tab`, `navigate` operate on
the user's own tabs; titles/URLs go only to the local bridge.

## Description (detailed)

opencode-chrome connects your terminal AI coding agent (opencode) to your
real Chrome, so it can use your logged-in sessions: Gmail, dashboards,
admin panels, your local dev servers.

How it works: a tiny local bridge (`npx opencode-chrome`, MCP server) +
this extension. No backend, no accounts, no analytics. Your model keys stay
in your opencode config (BYOK).

Tools: list_tabs, new_tab, close_tab, activate_tab, navigate, snapshot,
click, type, screenshot, wait_for.

Unofficial community project; not affiliated with the opencode project.
MIT licensed. Requires the npm package `opencode-chrome` and opencode
installed locally.

## Reviewer testing steps

1. `npx -y opencode-chrome` (needs Node 18+) — bridge listens on
   127.0.0.1:9223.
2. Load the unpacked extension; badge shows `on` when connected.
3. Without opencode: `websocat`/any WS client sending
   `{"id":1,"tool":"list_tabs","args":{}}` gets
   `{"id":1,"result":{"tabs":[...]}}`; extension badge shows debugger
   attach only during CDP tools.

## Assets

- Icon: `extension/icons/icon128.png`
- Screenshots (1280x800, required ≥1): pendiente — take during smoke test
  (badge on/off, banner during action, opencode session using tools).
