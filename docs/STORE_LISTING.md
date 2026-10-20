# Chrome Web Store listing

## Identity

- **Name:** opencode-chrome
- **Summary (≤132 chars):** Let opencode drive your real Chrome: logged-in sessions, cookies and tabs, via a local MCP bridge. Unofficial, BYOK.
- **Category:** Productivity
- **Language:** English (+ Spanish listing optional)
- **Privacy policy URL:** https://github.com/G10hdz/opencode-chrome/blob/main/docs/PRIVACY.md

## Single purpose

Let the local opencode MCP bridge operate the user's own browser tabs
(navigate, read page structure and content, interact with elements,
capture screenshots, inspect network and console, manage downloads) on
the user's instruction.

## chrome.debugger justification (required by review)

The `debugger` permission powers the tool set the user installs this
extension for, all through the Chrome DevTools Protocol: reading the page
(`snapshot`, `find`, `read_text`, `list_frames`, `list_console_messages`,
`list_network`/`get_network_body`, `list_storage_keys`), trusted input
(`click`, `hover`, `drag`, `type`, `fill`, `select`, `press_key`,
`scroll`, `upload`), form handling (`form_schema`, `apply_mapping`),
navigation and waiting (`navigate`, `wait_for`, `wait_download`),
presentation overrides (`screenshot`, `resize_page`, `emulate`), dialogs
(`list_dialogs`, `handle_dialog`) and declarative per-origin recipes
(`run_recipe`). There is no other way for an extension
to read page structure and dispatch trusted input events. Usage is:
attached on demand to the single tab the agent is acting on, detached
automatically after 30s idle. Nothing is sent anywhere except localhost
(127.0.0.1), to the user's own bridge process started by their own
`npx opencode-chrome` command.

## tabs permission justification

`list_tabs`, `new_tab`, `close_tab`, `activate_tab`, `navigate` operate on
the user's own tabs; titles/URLs go only to the local bridge.

## downloads permission justification

`wait_download` watches `chrome.downloads` for the file the user downloads
while the agent works and reports its saved path, size, mime and sha256.
Files land on the user's own disk; the extension never reads or uploads
them.

## alarms permission justification

The MV3 service worker can be suspended; the alarm wakes it on a schedule
so a dropped WebSocket to the local bridge reconnects without user action.

## storage permission justification

`chrome.storage.local` keeps the pairing token and user-saved form
profiles (values in `profiles.<name>` never leave the tab);
`chrome.storage.session` keeps attached tab ids and their exact origins,
cleared with the browser session.

## Description (detailed)

opencode-chrome connects your terminal AI coding agent (opencode) to your
real Chrome, so it can use your logged-in sessions: Gmail, dashboards,
admin panels, your local dev servers.

How it works: a tiny local bridge (`npx opencode-chrome`, MCP server) +
this extension. No backend, no accounts, no analytics. Your model keys stay
in your opencode config (BYOK).

Tools: tab management, navigation, page snapshots and text extraction,
trusted input (click, type, fill, upload), form autofill from local
profiles, screenshots, network/console/storage inspection, dialogs,
downloads, emulation, and declarative per-origin recipes. Sensitive
fields are redacted and gated for human takeover.

Unofficial community project; not affiliated with the opencode project.
MIT licensed. Requires the npm package `opencode-chrome` and opencode
installed locally.

## Reviewer testing steps

1. `npx -y opencode-chrome` (needs Node 18+) — bridge listens on
   127.0.0.1:19223.
2. Load the unpacked extension; badge shows `on` when connected.
3. Without opencode: `websocat`/any WS client sending
   `{"id":1,"tool":"list_tabs","args":{}}` gets
   `{"id":1,"result":{"tabs":[...]}}`; extension badge shows debugger
   attach only during CDP tools.

## Assets

- Icon: `extension/icons/icon128.png`
- Screenshots (1280x800): `assets/screenshot-1-hero.png`,
  `assets/screenshot-2-flow.png`, `assets/screenshot-3-tools.png`.
