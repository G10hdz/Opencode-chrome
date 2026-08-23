# opencode-chrome Product Specification

Status: Proposed  
Target: v0.2  
Last updated: 2026-08-22

## Product promise

Let any model running in OpenCode inspect and operate the Chrome tab the user
is already looking at, including its existing login session, while keeping the
user in control of every browser mutation.

This is an OpenCode-first browser driver, not a browser agent. OpenCode owns
the model and planning. The extension owns access to the real browser tab.

## Problem

Existing browser automation usually opens a separate profile, requires an
explicit session-adoption workflow, or exposes a very large CDP surface. That
does not feel like Claude in Chrome or Codex in Chrome and is risky for tasks
inside authenticated accounts.

The intended workflows include:

- editing a LinkedIn profile;
- drafting and sending messages;
- reviewing administrative dashboards;
- debugging local and deployed web applications;
- performing carefully reviewed changes such as DNS updates.

These workflows mix private page content with consequential actions. The
product must make the controlled tab and each mutation visible to the user.

## Goals

1. Use the user's normal Chrome profile, cookies, sessions, and extensions.
2. Make attaching the current tab a single explicit browser action.
3. Fail closed when a tab, origin, document, or referenced element changes.
4. Require OpenCode approval before every browser mutation.
5. Support the small interaction surface needed for forms and web debugging.
6. Keep all transport local with no backend, analytics, or bundled model.
7. Work with any model supported by OpenCode.

## Non-goals

- General scraping, crawling, or unattended browser farms.
- A side-panel chat client or a replacement for the OpenCode UI.
- Automatic detection of every dangerous button on arbitrary websites.
- Raw JavaScript, unrestricted CDP, cookie export, or response-body capture.
- Scheduled or background execution of consequential actions.
- Reimplementing Playwright or exposing hundreds of browser tools.

## Product principles

### The tab is selected by the user

Clicking the extension toolbar button attaches the current tab for the current
Chrome session. Commands without a `tabId` target the most recently attached
tab, never whichever unrelated tab happens to become active later.

The attachment is scoped to the exact origin. Cross-origin navigation revokes
it. Closing the tab or restarting Chrome also clears it.

### Read before acting

The packaged OpenCode instructions require a fresh snapshot before an action.
Mutation tools accept only refs from that snapshot. A ref is bound to the tab,
origin, document, and element fingerprint.

### Every mutation is a separate approval

`click`, `type`, `select_option`, `press_key`, `navigate`, `new_tab`,
`activate_tab`, and `close_tab` are configured as `ask` in OpenCode. Read-only
tools, scrolling, and hovering may run without another prompt after the user
attaches the tab.

Final actions such as Send, Save, Publish, Delete, Confirm, and DNS changes
must be their own tool call. The approval preview includes the origin, tab,
tool, ref, accessible name, and bounded arguments.

This is the enforceable v0.2 boundary. Generic web pages do not provide a
reliable transaction or commit API, and typing can itself trigger autosave.
The product therefore does not claim that semantic danger detection is a
security boundary.

### Browser content is sensitive

Snapshots, screenshots, console messages, and request URLs are sent back to
OpenCode and may reach the configured model provider. The extension never
sends them anywhere directly. Users should use a dedicated Chrome profile and
models appropriate for the data they open.

## User workflow

1. Install the MCP server and unpacked extension.
2. Configure the pairing token and the recommended OpenCode permissions.
3. Open the desired page in the normal Chrome profile.
4. Click the extension icon. The badge identifies the attached tab.
5. Ask OpenCode to inspect or modify the page.
6. Review each mutation request in OpenCode.
7. Approve the final Send, Save, Publish, or Confirm action separately.
8. Click the extension icon again to detach the tab when finished.

CAPTCHA, MFA, password entry, payment confirmation, and other human-only steps
remain manual. The agent takes a fresh snapshot after the user completes them.

## Functional requirements

### Tab access

| ID | Requirement |
|---|---|
| TAB-01 | The extension controls only user-attached tabs. |
| TAB-02 | Attachment is session-scoped and bound to the tab's exact origin. |
| TAB-03 | Cross-origin navigation, tab close, and explicit detach revoke access. |
| TAB-04 | Commands without `tabId` target the most recently attached tab. |
| TAB-05 | Results identify the actual tab, title, URL, and origin used. |

### Policy and approval

| ID | Requirement |
|---|---|
| POL-01 | All extension-side access checks fail closed. |
| POL-02 | All mutation tools ship with OpenCode `ask` configuration. |
| POL-03 | Documentation warns that `--auto` and Allow always weaken HITL. |
| POL-04 | Mutation previews contain enough target context for a human decision. |
| POL-05 | No arbitrary JavaScript or raw CDP tool is exposed in v0.2. |

### Page understanding and interaction

| ID | Requirement |
|---|---|
| ACT-01 | Snapshots return bounded text plus refs for visible interactive elements. |
| ACT-02 | Refs are bound to a snapshot and reject changed documents or elements. |
| ACT-03 | Click, type, select, hover, scroll, and keypress return action feedback. |
| ACT-04 | The target is visibly highlighted while a mutation runs. |
| ACT-05 | Navigation and waits have explicit timeouts and actionable errors. |

### Debugging

| ID | Requirement |
|---|---|
| DBG-01 | Capture bounded console errors and warnings for an attached tab. |
| DBG-02 | Capture bounded request failures and response status metadata. |
| DBG-03 | Omit cookies, authorization headers, request bodies, and response bodies. |
| DBG-04 | Clear diagnostic state on detach or tab close. |

### Operations

| ID | Requirement |
|---|---|
| OPS-01 | `doctor` verifies the bridge, extension protocol, and safe config hints. |
| OPS-02 | Extension and bridge negotiate a protocol version. |
| OPS-03 | A protocol mismatch fails with upgrade and reload instructions. |
| OPS-04 | Installation and runtime require no hosted service. |

## v0.2 tool surface

| Tool | Default policy | Purpose |
|---|---|---|
| `browser_status` | allow | Connection and attached-tab status. |
| `list_tabs` | allow | Attached tabs only. |
| `snapshot` | allow | Bounded page representation with refs. |
| `screenshot` | allow | Visible-tab PNG. |
| `console_messages` | allow | Bounded warnings and errors. |
| `network_requests` | allow | Bounded request status and failure metadata. |
| `wait_for` | allow | Wait for text or element state. |
| `new_tab` | ask | Open a tab. |
| `close_tab` | ask | Close an attached tab. |
| `activate_tab` | ask | Focus an attached tab. |
| `navigate` | ask | Navigate an attached tab. |
| `click` | ask | Click a fresh ref. |
| `type` | ask | Enter text into a fresh ref. |
| `select_option` | ask | Select an option on a fresh ref. |
| `press_key` | ask | Send one allowlisted key or chord. |
| `scroll` | allow | Scroll the page or a fresh ref. |
| `hover` | allow | Hover a fresh ref. |

The v0.2 list is a ceiling, not a checklist for one release. Tools are added in
dependency order only when the shared safety seam exists.

## Acceptance scenarios

### Authenticated profile edit

- The user attaches an already logged-in LinkedIn tab.
- OpenCode snapshots and proposes field edits.
- Each `type` call requires approval.
- Publish or Save is a separate approved `click`.
- A stale or cross-origin ref cannot be used.

### Message drafting

- OpenCode may inspect the attached conversation and fill a draft after approval.
- It cannot send the message without a separate approved click or keypress.
- The tool result identifies the target and final URL.

### DNS administration

- The product recommends a scoped API token over browser automation.
- If the browser is used, each field change and final confirmation requires approval.
- The agent verifies the resulting record through an independent read.

### Web debugging

- OpenCode can inspect the snapshot, screenshot, console errors, and failed requests.
- Diagnostics are bounded and redact sensitive headers and bodies.
- Detaching the tab clears diagnostic buffers and the debugger session.

## Release gates

- Manifest validation passes.
- Bridge tests pass without Chrome.
- Focused extension tests cover attachment, origin revocation, stale refs, and
  bounded diagnostics.
- A real-Chrome smoke test covers attach, snapshot, approved mutation, detach,
  and protocol mismatch.
- Security documentation describes local-process, prompt-injection, profile,
  model-provider, and Allow always risks.
- The full diff receives a security-focused human review before release.

## Delivery slices

| Slice | Outcome | Depends on | Delegation |
|---|---|---|---|
| S1 | Tab attachment and exact-origin policy | current bridge | Cheap implementer; flagship security review |
| S2 | Snapshot identity and stronger stale refs | S1 | Cheap implementer; flagship review |
| S3 | Action feedback and target highlight | S2 | Cheap implementer |
| S4 | Remaining form interaction tools | S2 | Cheap implementer |
| S5 | Bounded console and network diagnostics | S1 | Cheap implementer; flagship privacy review |
| S6 | Protocol negotiation and `doctor` | S1 | Cheap implementer |
| S7 | Real-Chrome smoke test and release docs | S1-S6 | Cheap implementer; human run |
