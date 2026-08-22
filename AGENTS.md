# AGENTS.md

Guidance for AI coding agents working in this repository. Humans: see
[CONTRIBUTING.md](CONTRIBUTING.md) for the contribution workflow.

## What this is

Two halves that talk over a localhost WebSocket:

- **Bridge** (`src/`) — a Node MCP server (stdio) that also runs a WebSocket
  server on `127.0.0.1:9223`. opencode calls MCP tools; the bridge forwards
  each call to the extension and returns the reply.
- **Extension** (`extension/`) — an MV3 service worker that connects to the
  bridge as a WebSocket client and drives the active tab through
  `chrome.debugger` (Chrome DevTools Protocol).

There is no backend and no build step. The extension is plain JS loaded
unpacked or zipped for the Chrome Web Store.

## Layout

```
src/index.js        MCP server + WebSocket server, token auth, request routing
src/tools.js        tool names, descriptions, zod schemas (the MCP surface)
extension/background.js   service worker: WS client + CDP tool implementations
extension/options.js/html token pairing UI
test/tools.test.js  node:test suite (spawns the bridge, fakes the extension)
scripts/check-manifest.js validates the manifest before test/pack
scripts/pack-extension.sh zips extension/ into dist/ for CWS
```

## Commands

```bash
npm test                       # check-manifest + node:test (no Chrome needed)
node scripts/check-manifest.js # manifest sanity only
npm run pack                   # dist/opencode-chrome-<version>.zip
```

## The tool contract lives in three places

Adding, renaming, or removing a tool means editing all three, or tests and
runtime drift apart:

1. `src/tools.js` — the `TOOLS` array (name, description, zod schema).
2. `extension/background.js` — the `TOOLS` map (name → implementation).
3. `test/tools.test.js` — the `EXPECTED_TOOLS` list.

The wire protocol is JSON both ways: bridge → extension `{id, tool, args}`,
extension → bridge `{id, result}` or `{id, error: {message}}`. A `result`
with a string `image` field is turned into MCP image content; everything else
is JSON-stringified into text.

## Security invariants (do not weaken)

- The WebSocket server binds to `127.0.0.1` only.
- Connections are rejected unless the `token` query param matches the shared
  token, and unless the `Origin` (when present) is `chrome-extension://`.
- Refs from a snapshot carry a fingerprint; `resolveRef` re-checks the
  element before click/type and forces a fresh snapshot if it changed. Keep
  `nameOf` identical between `SNAPSHOT_SCRIPT` and `REF_CHECK_SCRIPT`.
- The debugger auto-detaches after idle; navigation invalidates cached refs.

If a change touches any of these, call it out explicitly in the PR.

## Conventions

- ES modules, Node 18+, no transpiler.
- Keep dependencies minimal. The runtime deps are `@modelcontextprotocol/sdk`,
  `ws`, and `zod`. Don't add one for something a few lines can do.
- Tests use `node:test` and a fake extension over WebSocket; they must keep
  passing without a real Chrome.
- Match the surrounding style. Write commits and PRs in a plain human voice,
  no AI-attribution trailers or generated-code banners.
