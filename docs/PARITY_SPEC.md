# Frontier parity spec

Spec-level design for closing the feature gap between opencode-chrome and
frontier-lab browser agents (Claude in Chrome, OpenAI Operator/Atlas,
Project Mariner) plus the richer open-source surfaces (OpenCLI, Stagehand,
browser-use, chrome-devtools-mcp). Goal: operational parity while keeping
the strict security model — attached tabs only, origin-scoped, localhost
bridge, token auth.

Status: draft for review.

Companion spec: `AUTOFILL_SPEC.md` (form filling vertical slice).

## Evidence

- E-1: Gemini Deep Research report (2026-10-08),
  `~/Downloads/gemini-deep-research-browser-agent-feature-gap-analysis.md`.
  Feature matrix across 10+ projects, CDP feasibility analysis, security
  comparison, phased roadmap, repo mining index. Claims are Gemini's,
  verified against opencode-chrome source where noted.
- E-2: `extension/background.js`, `src/tools.js` — current surface is
  12 tools: browser_status, list_tabs, new_tab, close_tab, activate_tab,
  navigate, snapshot, read_text, click, type, screenshot, wait_for.
  `click` uses `el.click()` (untrusted); `type` uses `Input.insertText`
  (trusted). No network, no file I/O, no fingerprinting beyond
  `REF_CHECK_SCRIPT`, no structured error codes.
- E-3: OpenCLI npm package (`@jackwener/opencli@1.8.8`, installed) —
  match_level tiers, compound control envelopes, `browser network`
  capture with disk cache, adapter registry, structured error envelopes.

## Current gaps (from E-1 matrix, verified against E-2)

| Dimension | Status |
|---|---|
| Element targeting | numeric ref only; no CSS, no semantic locators, no staleness tiers |
| Interaction | click + type only; no hover/drag/select/check/upload/keys/scroll/back |
| Network | none — pure DOM/a11y scraping |
| File I/O | none — no upload, no download tracking |
| Errors | unstructured strings, no codes, no recovery hints |
| Snapshot | full a11y tree, no pruning, no viewport culling, no compound controls |
| Frames/shadow DOM | root frame only |
| Safety gating | none — all tools execute; attach is the only gate |
| Tracing | none |
| Site memory | none (OpenCLI has adapters + sitemaps) |

## Phased roadmap

### Phase 1 — CDP-free capabilities (no new permissions)

All implementable over the existing `chrome.debugger` channel:

1. **`fill`** — atomic value set via `Runtime.evaluate`: native prototype
   setter + bubbling `input`/`change` (React/Vue-safe). Distinct from
   `type` (which stays keystroke-level for autocomplete fields).
   Returns `{filled, verified, actual}`.
2. **`select`** — set `selectedIndex` on `<option>`, dispatch `change`.
   Error includes `available[]` option labels.
3. **`hover` / `drag`** — `Input.dispatchMouseEvent` sequences;
   drag = press + intermediate mouseMoved + release.
4. **`upload`** — `DOM.setFileInputFiles` with `backendNodeId`; bridge
   resolves local paths, verifies existence.
5. **`network` inspection** — `Network.enable` on attach, ring buffer of
   ~100 transactions, tools `list_network` (shape preview: method/status/
   url/ct/size) + `get_network_body(requestId)`. API-over-scraping is the
   single biggest extraction win.
6. **Trusted clicks** — migrate `click` from `el.click()` to
   `Input.dispatchMouseEvent` at `DOM.getBoxModel` coordinates, so write
   actions carry `isTrusted: true` (required by ATS/bot telemetry).
7. **Structured error envelopes** — `{status, error_code, remedy,
   dom_mutation_detected}` on every tool; codes like `STALE_REF`,
   `SELECTOR_AMBIGUOUS`, `ELEMENT_OBSCURED`, `NAVIGATION_BLOCKED`,
   `HUMAN_TAKEOVER_REQUIRED`.

### Phase 2 — Perception and resilience

8. **Triple-tier fingerprinting** — snapshot records `{role, name,
   depth, ancestorId, classHash}` per ref; resolver tries exact →
   stable → reidentified and reports `match_level` on every write.
9. **Compound control envelopes** — `<select>`/combobox/date/file inputs
   serialized inline in snapshot: current value, options (cap 50 +
   `options_total`), format, accept. Kills the click→snapshot→click
   round trip for dropdowns.
10. **A11y pruning + `in_viewport_only`** — drop non-interactive
    wrappers; cross-reference box models for viewport culling.
11. **Screenshot annotation** — ephemeral canvas overlay with `[N]`
    badges over actionable elements (set-of-marks), removed before
    layout cycles. For icon-only/ambiguous UIs.

### Phase 3 — Architectural

12. **OOPIF / iframe traversal** — `Target.setAutoAttach{flatten:true}`
    on the debugger session, `sessionId` registry, route CDP calls into
    subframes. Required for embedded checkouts/auth widgets.
13. **Sensitive-field masking + human takeover** — redact
    `type=password`, `autocomplete=cc-*`, CVV/SSN-labeled inputs from
    snapshots; writes to redacted refs return `HUMAN_TAKEOVER_REQUIRED`.
    This is the frontier-lab pattern (credentials/checkout/CAPTCHA pause)
    and the strongest place to be *stricter* than open-source peers.
14. **Configurable origin policy** — keep exact-origin default; add
    per-profile allowlists so legitimate cross-origin flows (SSO
    redirects) work without weakening the default. Policy lives in the
    bridge, not the page.
15. **Downloads** — `chrome.downloads` permission (new manifest entry,
    flagged for review); `wait_download` + saved-path/checksum return.
16. **Site recipe registry** — declarative per-origin adapters
    (`navigate → wait_for → eval → columns`), stored under
    `~/.config/opencode-chrome/adapters/` (alongside the token and
    policy.json), gated by the same origin scope as attachments. This is
    the OpenCLI moat; on top of it, AUTOFILL_SPEC's
    `form_schema`/`apply_mapping` become the first shipped recipe family.

## Security invariants (unchanged or stronger)

- WS binds `127.0.0.1`, token + `chrome-extension://` Origin — keep.
- `resolveTabId` stays the only path to a page — new tools resolve
  through it, no direct tab/debugger bypass.
- Origin-bound attachment stays the default; Phase 3 policy engine only
  widens on explicit user config.
- Wrap extracted page content in `<untrusted_web_content>` tags in MCP
  responses — page content is data, not instructions.
- New manifest permissions beyond `downloads`: none planned. Anything
  else requiring one gets flagged in the PR.

## Requirements

| REQ | Criterion | Basis | Verification |
|---|---|---|---|
| R-1 | WHEN a fill targets a controlled input, THE value SHALL persist across framework re-renders | E-1 §fill | React fixture; fill; re-render; assert |
| R-2 | WHEN a ref drifts between snapshot and action, THE tool SHALL resolve via fingerprint and report `match_level` | E-3 | Mutate attrs; assert `stable`/`reidentified` |
| R-3 | WHEN any tool fails, THE response SHALL include `error_code` + `remedy` | E-1 §envelopes | Force each failure class; assert shape |
| R-4 | WHEN a tab makes XHR/fetch calls, `list_network` SHALL surface them with shape previews | E-1 §network | Fixture page with fetch; assert capture |
| R-5 | WHEN a snapshot hits a sensitive field (password, cc), THE field SHALL appear redacted | E-1 §masking | Fixture with password input |
| R-6 | WHEN the agent writes to a redacted ref, THE tool SHALL return `HUMAN_TAKEOVER_REQUIRED` | E-1 §takeover | Attempt type on password ref |
| R-7 | WHEN a write tool executes, THE resulting DOM events SHALL carry `isTrusted: true` | E-1 §isTrusted | Assert isTrusted in page after click |
| R-8 | WHEN a `<select>` is snapshotted, THE envelope SHALL include options (≤50) + `options_total` | E-3 | Fixture select; assert compound field |

## Open questions

1. Write-gate UX: how does the bridge surface a confirmation? Options:
   REQUIRES_CONFIRMATION error + retry, pending queue + `confirm` tool,
   or extension popup. Needs design before Phase 3.
2. Does `eval` ship (read-only JS in page)? OpenCLI has it and it covers
   every long-tail extraction; also the largest injection surface. Lean:
   ship it, mark `access: read`, document the boundary.
3. Recipe/adapters: own format or consume OpenCLI `clis/*` modules?
   Their registry is richer than we'd build alone; compat layer worth
   evaluating before designing ours.
