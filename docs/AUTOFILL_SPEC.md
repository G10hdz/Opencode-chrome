# Form autofill spec

Spec-level design for adding structured form filling to opencode-chrome.
Scope: reading a form into a schema, mapping profile data onto it, and
filling — with the user keeping the final submit. Bulk autonomous
application loops (LinkedIn Easy Apply runners etc.) are out of scope.

Status: draft for review.

## Why this feature

Form filling is the highest-frequency write operation a browser agent does
(signup, checkout, ATS applications, admin panels). Today the only write
path is `click` + `type` per element, which means the model re-derives the
mapping of "which field gets which value" on every page, burns a snapshot
per field, and has no privacy boundary between the user's personal data and
the model context.

## Evidence

- E-1: Job-autofill research report (Gemini Deep Research, 2026-10-08),
  `~/Downloads/job-application-autofill-research.md`. Covers FormFilla
  (Hungarian bipartite matching), JobMatchAI (side-panel staging, BYOK),
  OpenJobAutofill (schema-isolated PII), AutoApplyMax (multi-selector
  recovery), plus platform defense profiles for LinkedIn/Workday/
  Greenhouse/Lever.
- E-2: `extension/background.js` — current `toolClick` uses
  `el.click()` (untrusted event); `toolType` already uses
  `Input.insertText` (trusted). `toolReadText`/`toolSnapshot` exist.
- E-3: OpenCLI `opencli-browser` skill — target contract (ref|CSS|semantic),
  `match_level` envelope, `fill` with verified read-back, `select` by
  label, compound form metadata (date format, select options, file accept).

## Hard constraints from the evidence

1. `Event.isTrusted` is false for `el.click()` and `dispatchEvent`. Sites
   that care (LinkedIn, some ATS) flag or revert. CDP `Input.dispatch*`
   produces trusted events — we already use it for typing; clicks and
   selects must go through it too, or the human clicks the critical
   buttons (proposed: both — trusted CDP for field ops, human for final
   submit).
2. React/controlled inputs revert `input.value = x`. Must call the
   native prototype setter then dispatch bubbling `input`/`change`.
   Observed pattern from E-1.
3. Honeypot fields (`display:none`, `opacity:0`, off-screen) must be
   filtered before any mapping — check `getBoundingClientRect()` +
   computed style in the schema extractor.
4. Workday-class portals don't render fields below certain viewport
   widths and use shadow DOM; extraction must record visibility state and
   pierce shadow roots where possible, else report `unreachable`.

## Proposed tools (MCP surface)

New tools in `src/tools.js` + `extension/background.js` +
`test/tools.test.js` (all three, per AGENTS.md):

| Tool | Args | Returns | Notes |
|---|---|---|---|
| `form_schema` | `tabId?` | `{fields: [{ref, kind, label, name, autocomplete, options?, compound?, required, visible}]} ` | Read-only. Enumerates inputs/selects/textareas + ARIA labels, fieldset legends, autocomplete tokens. Filters honeypots; reports `hidden_count`. |
| `fill` | `ref`, `value`, `tabId?` | `{filled, verified, actual}` (`match_level` lands with fingerprinting, PARITY_SPEC Phase 2) | Native setter + bubbling events, then read-back verify. Trusted via CDP where possible. |
| `select` | `ref`, `option`, `tabId?` | `{selected, actual, match_level}` | Match by label then value; error lists `available[]` labels. |
| `apply_mapping` | `mapping: {ref: profileKey}`, `profile: str`, `tabId?` | `{filled: n, failed: [{ref, reason}], unmapped_keys: []}` | The privacy boundary — see below. |
| `list_profile_keys` | `profile: str` | `{keys: []}` | Names only, never values. |

## The PII boundary (core design point, from E-1/OpenJobAutofill)

Profiles live in `chrome.storage.local` under the extension's origin —
the model never sees values.

```
agent                    extension                     page
  │  form_schema           │                             │
  │───────────────────────>│ enumerate + filter          │
  │<─── {fields, keys?} ───│ (no values)                 │
  │                        │                             │
  │  apply_mapping         │                             │
  │  {ref→profileKey}      │ resolve keys from           │
  │───────────────────────>│ chrome.storage.local        │
  │                        │ fill via trusted events ───>│
  │<── {filled, failed} ───│                             │
```

The agent emits only `{ref → profileKey}` mappings (e.g. `full_name`,
`email`, `phone`). `profileKey` values are enumerated by a read-only
`list_profile_keys` tool (names only, never values). If a field has no
profile key, the agent may still `fill` it with literal text it generated
(cover letter, screening answer) — that's the agent's own output, not
leaked PII.

Profile editing UI (options page) is out of scope for the spec — schema
and storage format below are the deliverable.

## Requirements

| REQ | Criterion | Basis | Verification |
|---|---|---|---|
| R-1 | WHEN `form_schema` runs on a page with a form, THE tool SHALL return every visible input/select/textarea with label text and autocomplete token | E-1, E-3 | Fixture page with 10+ field types; assert schema covers all |
| R-2 | WHEN a field is honeypot-hidden, THE tool SHALL exclude it from `fields` and count it in `hidden_count` | E-1 §honeypots | Fixture with `display:none` + off-screen input |
| R-3 | WHEN `fill` sets a React-controlled input, THE value SHALL persist after re-render | E-1 §React | Controlled-input fixture; fill; trigger re-render; assert value |
| R-4 | WHEN `fill`/`select` resolve a stale ref, THE response SHALL include `match_level` and re-identify by role+name when possible | E-3 | Mutate soft attrs between snapshot and fill; assert `stable`/`reidentified` |
| R-5 | WHEN `apply_mapping` references a missing key, THE tool SHALL leave that field untouched and list it in `unmapped_keys` | Proposed | Mapping with bogus key; assert field empty + reported |
| R-6 | THE extension SHALL NOT transmit profile values over the WebSocket | E-1 privacy | Assert mapping payload contains keys only; no value strings on wire |
| R-7 | WHEN the user submits, THE click SHALL be trusted or human-performed | E-1 §isTrusted | `Input.dispatchMouseEvent` path; `isTrusted` assertion in page |
| R-8 | WHEN `select` gets an unknown option, THE error SHALL include `available[]` labels | E-3 | Select with bad option; assert error envelope |

## Non-goals

- Autonomous submit loops, CAPTCHA solving, login automation.
- Resume parsing, cover-letter generation — that's agent-side work.
- A bundled profile editor UI (v2; storage schema is specified so a
  community UI can be built).
- Shadow-DOM piercing beyond best-effort (Workday known-hard).

## Storage schema (proposed)

```
chrome.storage.local.profiles = {
  "<profileName>": { "<key>": "<value>", ... }
}
```

Flat string map. Keys are agent-visible names; values never leave the
extension. Reserved future keys: `_meta.created`, `_meta.source`.

## Open questions

1. Does `apply_mapping` need a dry-run/`preview` mode that returns the
   diff without writing? (JobMatchAI does a side-panel staging step; our
   equivalent is agent-readable diff output.)
2. Multi-step wizards (Next → fill → Next): keep per-page `form_schema`
   calls, or a `wizard_step` helper that clicks Next and re-extracts?
   Lean: per-page calls, agent loops.
3. Where do semantic locators (`--role/--name`) land — this spec or the
   general target-contract spec? Proposal: land the dual `ref|css`
   contract here, role/name in the broader selector work.
