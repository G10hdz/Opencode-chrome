# Chat spec

Spec-level design for a side-panel chat that turns opencode-chrome into a
standalone browser agent: the user talks to a model from inside Chrome and
the model drives attached tabs through the existing tool surface. No MCP
client required. BYOK lives in the bridge, never in the extension.

Status: draft for review.

## Evidence

- E-1: MCP sampling path rejected. opencode's MCP client does not declare
  the `sampling` capability (commented out in
  `packages/opencode/src/mcp/index.ts`; issue anomalyco/opencode#11948
  closed unimplemented). Sampling is also deprecated in MCP spec
  2026-07-28 (SEP-2577): new implementations should call provider APIs
  directly. A chat built on sampling would have no working client.
- E-2: `PRODUCT_SPEC.md` lists "a side-panel chat client" as a non-goal.
  This spec proposes revising that line; see Product changes.
- E-3: Bridge protocol (`src/index.js`): `{id, tool, args}` →
  `{id, result|error}` over a token'd WS gated on `chrome-extension://`
  Origin. Second MCP processes attach as `role=peer` with no Origin.
  Chat rides the same extension socket as a separate message namespace.
- E-4: Extension (`extension/background.js`): WS client plus
  `chrome.runtime.onMessage` relay plus service-worker keepalive. The
  panel reaches the worker over a `chrome.runtime` Port; the worker
  relays frames to the bridge.

## Design

### 1. Side panel (extension)

- New `sidePanel` permission and `side_panel.default_path` →
  `sidepanel.html`.
- The action click keeps attaching the tab, then calls
  `chrome.sidePanel.open({tabId})`: one gesture attaches and opens.
  The panel also opens from Chrome's side-panel UI at any time.
- The panel is a terminal only: transcript, input box, streaming reply,
  one line per tool call, approve/deny buttons on write-gate prompts.
  No LLM code, no keys, no page access beyond what the bridge returns.
- Talks to `background.js` over a `chrome.runtime.connect` Port; the
  worker relays chat frames to the WS.

### 2. Wire protocol (extension ↔ bridge)

New namespaced frames on the existing authenticated socket:

- ext→bridge `{chat: {id, text, tabId?}}`: user turn; `tabId` defaults
  to the most recently attached tab on this port.
- bridge→ext `{chat_delta: {id, text}}`: streamed text.
- bridge→ext `{chat_tool: {id, name, summary}}`: a tool call started or
  finished; rendered as an activity line in the transcript.
- bridge→ext `{chat_confirm: {id, tool, args, prompt}}`: write-gate;
  the loop pauses until the user answers.
- ext→bridge `{chat_answer: {id, approved}}`, `{chat_cancel: {id}}`.
- bridge→ext `{chat_done: {id}}`, `{chat_error: {id, message}}`.

Chat frames are accepted only on the extension socket; peers get
`chat_error`. Tool calls issued by the loop reuse the existing
`{id, tool, args}` channel unchanged.

### 3. Agent loop (bridge, `src/chat.js`)

- Config at `~/.config/opencode-chrome/chat.json` (mode 0600,
  user-authored, same trust class as the token and policy.json):
  `{provider, base_url, api_key, model, max_turns?}`. Missing or invalid
  file → `chat_error` with `chat_not_configured` and a remedy.
- Providers for v1: `anthropic` (POST `/v1/messages`, SSE) and
  `openai` (POST `/chat/completions`, SSE; covers OpenAI, OpenRouter,
  Ollama, Groq). Raw `fetch` plus a small SSE parser; no new dependency.
- Tools: a JSON-schema projection of the `TOOLS` zod schemas via a small
  converter for the subset in use (string/number/boolean/enum/array/
  record/optional). A schema feature the converter cannot express fails
  the build, it does not silently drop.
- Loop: system prompt (attached-tab context, tool rules, untrusted
  content), then provider → tool calls dispatched through the same
  sendToolCall path MCP tools use → results wrapped in
  `<untrusted_web_content>` → feed back. Caps: `max_turns` (default 25)
  and a wall-clock limit.
- Write-gate: a `READ_TOOLS` set (`browser_status`, `list_tabs`,
  `snapshot`, `find`, `read_text`, `list_frames`, `form_schema`,
  `list_profile_keys`, `list_dialogs`, `list_network`,
  `list_storage_keys`, `list_console_messages`, `get_network_body`,
  `screenshot`, `list_recipes`, `wait_for`, `wait_download`) runs
  directly; every other tool emits `chat_confirm` first. This answers
  PARITY_SPEC open question 1 for the chat surface.
- `human_takeover_required` and other `error_code`s render as actionable
  transcript lines, not stack traces.
- History lives in the loop for the panel session; nothing is persisted
  to disk.

### 4. Standalone mode

`opencode-chrome --serve` runs the WS server and chat without the stdio
MCP transport, so the panel works with no client running. Session cap
and peer logic stay unchanged.

## Product changes

- `PRODUCT_SPEC.md`: remove "a side-panel chat client" from non-goals;
  add BYOK agent loop to goals. Still out: unattended/scheduled runs,
  scraping farms, replacing the OpenCode UI for MCP users.
- `PRIVACY.md`, `STORE_LISTING.md`: declare the new data flow — tool
  results (page content) leave localhost for the provider endpoint
  configured in chat.json. Same class as sending them to the MCP
  client's model; a different, user-chosen destination.
- `ARCHITECTURE.md`: new `src/chat.js` module and side-panel component.

## Security invariants (unchanged or stronger)

- `chat.json` mode 0600; the key never crosses the WS, never lands in
  logs or tool results, and is scrubbed from provider error paths
  (Authorization/x-api-key headers are not echoed).
- Chat frames are accepted only on the extension socket (token +
  `chrome-extension://` Origin); a peer that sends one gets
  `chat_error`.
- Every chat tool call resolves through `resolveTabId`, the origin
  allowlist, and the sensitive-field gate, identical to MCP-issued
  calls. `resolveRef` still owns `human_takeover_required`.
- Page content reaches the model only through tool results wrapped in
  `<untrusted_web_content>`; the panel cannot inject raw page text.
- New manifest permission: `sidePanel` only. No `host_permissions`, no
  remote code.
- The write-gate keeps the product principle "every mutation is a
  separate approval" that the MCP client enforced before.

## Requirements

| REQ | Criterion | Basis | Verification |
|---|---|---|---|
| C-1 | WHEN chat.json is missing or invalid, a chat turn SHALL fail with chat_not_configured plus a remedy | E-3 config pattern | Panel turn without config; assert frame |
| C-2 | WHEN the model emits a write tool call, THE loop SHALL pause until chat_answer arrives | Write-gate | Fake provider emits `click`; assert confirm + resume |
| C-3 | WHEN a peer sends a chat frame, THE bridge SHALL reject it with chat_error | Origin invariant | Peer socket test |
| C-4 | WHEN a tool returns page content, THE forwarded message SHALL wrap it in untrusted_web_content | E-3 invariant | Inspect loop payload |
| C-5 | WHEN a tab is attached, THE side panel SHALL open bound to that tab | UX | e2e-smoke or manual check |
| C-6 | WHEN max_turns is reached, THE loop SHALL end with chat_done and a truncated marker | Loop cap | Fake provider loops tools |
| C-7 | WHEN chat config errors occur, THE output SHALL NOT contain the API key | Key hygiene | Grep emitted frames and stderr |

## Open questions

1. Providers at launch: anthropic + openai-compatible, or
   openai-compatible only?
2. "Approve always" per tool for the rest of a chat session: v1 or a
   follow-up?
3. Chat history across panel reopens: keep in worker memory or
   `chrome.storage.session`?
4. Does the panel show raw tool args/results (transparency) or one-line
   summaries?
5. Recorder (export a Playwright spec from a session) stays a separate
   product; out of scope here.
