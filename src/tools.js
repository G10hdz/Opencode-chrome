import { writeFileSync } from "node:fs";
import { z } from "zod";

const tabId = z.number().int().optional();
const ref = z.union([z.string(), z.number()]);
// include_snapshot: mutaciones devuelven el árbol fresco en la misma respuesta
// (sus refs reemplazan a los del snapshot anterior — el DOM ya cambió)
const includeSnapshot = z.boolean().optional();
// output_path: payloads grandes (snapshot/screenshot/body) a archivo en vez de inline
const outputPath = z.string().optional();

export const TOOLS = [
  { name: "browser_status", description: "Report bridge connection and attached tabs.", schema: {} },
  {
    name: "list_tabs",
    description: "List open tabs with id, title and url.",
    schema: {},
  },
  {
    name: "new_tab",
    description: "Open a new tab, optionally at a URL. background:true opens it without focusing.",
    schema: { url: z.string().optional(), background: z.boolean().optional() },
  },
  {
    name: "close_tab",
    description: "Close the tab with the given id.",
    schema: { id: z.number().int() },
  },
  {
    name: "activate_tab",
    description: "Focus the tab with the given id.",
    schema: { id: z.number().int() },
  },
  {
    name: "navigate",
    description:
      "Navigate the tab and wait for the load to finish. Pass exactly one of: url (go to URL), or action back/forward/reload (history navigation via Page.navigateToHistoryEntry / Page.reload). ignore_cache:true bypasses the HTTP cache during the navigation. If the landing origin is outside the attachment's reach the tab detaches (origin_changed on the next call) and include_snapshot yields detached_after_nav instead of a tree. include_snapshot:true returns a fresh snapshot in the same response.",
    schema: {
      url: z.string().optional(),
      action: z.enum(["back", "forward", "reload"]).optional(),
      ignore_cache: z.boolean().optional(),
      tabId,
      include_snapshot: includeSnapshot,
    },
  },
  {
    name: "snapshot",
    description:
      "Accessibility tree of the page as text, with [ref] markers on interactive elements. Options: selector scopes to a subtree, interactive_only drops text lines, in_viewport_only keeps only visible-on-screen elements, max_chars caps output (default 20000), frame scopes to an embedded out-of-process iframe (frameId or url substring from list_frames; its origin must be allowlisted). Sensitive fields (passwords, card and identity numbers) appear redacted with a sensitive=<reason> marker and reject agent input with human_takeover_required. output_path writes the tree to a file and returns {path, bytes} instead.",
    schema: {
      tabId,
      selector: z.string().optional(),
      interactive_only: z.boolean().optional(),
      in_viewport_only: z.boolean().optional(),
      max_chars: z.number().int().positive().optional(),
      frame: z.string().optional(),
      output_path: outputPath,
    },
  },
  {
    name: "find",
    description:
      "Find interactive elements by accessible-name text (substring, case-insensitive) and/or role (button, link, textbox, combobox, checkbox, radio...). Optional selector scopes the search. Returns matching [ref] lines only — refs are usable with click/type/etc. output_path writes the matches to a file and returns {path, bytes} instead.",
    schema: {
      text: z.string().optional(),
      role: z.string().optional(),
      selector: z.string().optional(),
      frame: z.string().optional(),
      output_path: outputPath,
      tabId,
    },
  },
  {
    name: "read_text",
    description:
      "innerText of the element matching the CSS selector (defaults to body). Scrolls to bottom first to hydrate lazy sections; scroll:false skips it. Read-only. output_path writes the text to a file and returns {path, bytes} instead.",
    schema: { selector: z.string().optional(), max: z.number().int().optional(), scroll: z.boolean().optional(), frame: z.string().optional(), output_path: outputPath, tabId },
  },
  {
    name: "list_frames",
    description:
      "List the tab's frame tree: frameId, url, parent, oopif flag, sessionId and whether the frame's origin is allowed by the tab's origin allowlist. An out-of-process iframe is only reachable when its origin is allowlisted for the attached origin (same rule as an SSO redirect — see ~/.config/opencode-chrome/policy.json). Pass its frameId or a unique url substring as `frame` to snapshot/find/read_text.",
    schema: { tabId },
  },
  {
    name: "click",
    description: "Click the element captured with the given ref in the latest snapshot. include_snapshot:true returns a fresh snapshot in the same response.",
    schema: { ref, tabId, include_snapshot: includeSnapshot },
  },
  {
    name: "hover",
    description:
      "Move the pointer over the element with the given ref (trusted mouseMoved over CDP). Useful for menus and tooltips. include_snapshot:true returns a fresh snapshot in the same response.",
    schema: { ref, tabId, include_snapshot: includeSnapshot },
  },
  {
    name: "drag",
    description:
      "Drag the element with ref `from` onto the element with ref `to`, as a trusted press-move-release mouse sequence. include_snapshot:true returns a fresh snapshot in the same response.",
    schema: { from: ref, to: ref, tabId, include_snapshot: includeSnapshot },
  },
  {
    name: "type",
    description:
      "Type text into the element with the given ref; a trailing newline sends Enter. include_snapshot:true returns a fresh snapshot in the same response.",
    schema: { ref, text: z.string(), tabId, include_snapshot: includeSnapshot },
  },
  {
    name: "fill",
    description:
      "Set the value of an input, textarea or contenteditable in one shot. Uses the native property setter so React/Vue controlled fields keep it, then verifies by reading the value back. Prefer over type when no autocomplete is involved. include_snapshot:true returns a fresh snapshot in the same response.",
    schema: { ref, value: z.string(), tabId, include_snapshot: includeSnapshot },
  },
  {
    name: "select",
    description:
      "Pick an <option> on a <select> by label or value, then dispatch input/change. On failure the error lists the available options. include_snapshot:true returns a fresh snapshot in the same response.",
    schema: { ref, option: z.string(), tabId, include_snapshot: includeSnapshot },
  },
  {
    name: "form_schema",
    description:
      "Enumerate the form fields on the page: ref, kind, label, name, autocomplete token, required, sensitive flag, and options for selects. Hidden honeypot fields are excluded and counted in hidden_count. Returned refs work with fill/select/click. frame scopes to an allowlisted embedded frame like snapshot.",
    schema: { tabId, frame: z.string().optional() },
  },
  {
    name: "apply_mapping",
    description:
      "Fill several fields in one call from a stored autofill profile: mapping is {ref: profileKey}. Profile values are resolved inside the extension from chrome.storage.local and never cross the wire or appear in the result. Missing keys land in unmapped_keys and leave the field untouched; per-field failures land in failed[]. include_snapshot:true returns a fresh snapshot in the same response.",
    schema: {
      mapping: z.record(z.string(), z.string()),
      profile: z.string(),
      include_snapshot: includeSnapshot,
      tabId,
    },
  },
  {
    name: "list_profile_keys",
    description:
      "List the key names stored for an autofill profile (chrome.storage.local.profiles.<profile>). Names only — values never leave the extension.",
    schema: { profile: z.string() },
  },
  {
    name: "press_key",
    description:
      "Press a key or modifier combo on the focused element: named keys (Enter, Tab, Escape, Backspace, Delete, arrows, Home, End, PageUp, PageDown, Space) or a single printable character, optionally prefixed with Alt+/Control+/Meta+/Shift+ (e.g. \"Control+A\", \"Shift+Tab\"). For typing text use type/fill. include_snapshot:true returns a fresh snapshot in the same response.",
    schema: { key: z.string(), tabId, include_snapshot: includeSnapshot },
  },
  {
    name: "scroll",
    description:
      "Scroll the page. With ref, scrolls that element into view; with dx/dy, scrolls the window by that many pixels (default dy 600 down). Returns the new position and at_bottom. include_snapshot:true returns a fresh snapshot in the same response.",
    schema: { ref: ref.optional(), dx: z.number().optional(), dy: z.number().optional(), include_snapshot: includeSnapshot, tabId },
  },
  {
    name: "upload",
    description:
      "Set local file paths on a <input type=file> via DOM.setFileInputFiles. files are absolute paths on the machine running Chrome. include_snapshot:true returns a fresh snapshot in the same response.",
    schema: { ref, files: z.array(z.string()).min(1), tabId, include_snapshot: includeSnapshot },
  },
  {
    name: "list_dialogs",
    description:
      "JavaScript dialogs (alert/confirm/prompt/beforeunload) on the tab: the pending one if any, plus recently auto-handled ones and the current policy.",
    schema: { tabId },
  },
  {
    name: "handle_dialog",
    description:
      "Set how JS dialogs are auto-answered on the tab: action accept (default) or dismiss, optional prompt_text for prompt() dialogs. If a dialog is pending right now, it is answered with these settings.",
    schema: { action: z.enum(["accept", "dismiss"]), prompt_text: z.string().optional(), tabId },
  },
  {
    name: "list_network",
    description:
      "List recent network requests on the tab (ring buffer of ~100): method, url, status, type, size. Optional filter matches substring of url.",
    schema: { tabId, filter: z.string().optional() },
  },
  {
    name: "list_console_messages",
    description:
      "Recent console messages on the tab (ring buffer of ~200): console API calls, uncaught exceptions and browser log entries (network errors, deprecations). Each entry: {type, source, text, url?, line?, ts}. Optional types array filters by exact type (log, error, warn, info, debug...), filter matches a substring of the text.",
    schema: { tabId, types: z.array(z.string()).optional(), filter: z.string().optional() },
  },
  {
    name: "get_network_body",
    description:
      "Fetch the response body of a requestId seen in list_network. Text bodies over ~200KB are truncated; binary comes back base64Encoded. output_path writes the body to a file and returns {path, bytes} instead.",
    schema: { requestId: z.string(), output_path: outputPath, tabId },
  },
  {
    name: "screenshot",
    description:
      "Capture a PNG screenshot of the tab, returned as base64. annotate:true overlays [N] badges on the elements matching the latest snapshot refs, so the image lines up with ref numbers. output_path writes the PNG to a file and returns {path, bytes} instead.",
    schema: { tabId, annotate: z.boolean().optional(), output_path: outputPath },
  },
  {
    name: "list_recipes",
    description:
      "List site adapters installed in ~/.config/opencode-chrome/adapters/ (name, origin, description, declared params). Answered locally by the bridge; no tab needed.",
    local: true,
    schema: {},
  },
  {
    name: "run_recipe",
    description:
      "Run a site adapter from ~/.config/opencode-chrome/adapters/<name>.json on an attached tab. The adapter's declared `origin` must be within the attachment's reach (exact or allowlisted). Steps: navigate, wait_for, eval, columns — `columns` projects the last eval result into {columns, rows}. `params` fills {{key}} placeholders; inside `eval` steps each {{key}} becomes a JSON-encoded literal (write it bare, no quotes).",
    schema: { name: z.string(), params: z.record(z.string()).optional(), tabId },
  },
  {
    name: "wait_download",
    description:
      "Wait for a browser download to finish (timeout_ms, default 30000). Returns the saved path, bytes, mime, source url and a sha256 of the file computed by the bridge. Downloads are global to the browser (not per-tab) and land in the user's normal download directory. Requires an attached tab.",
    schema: { timeout_ms: z.number().int().positive().optional(), tabId },
  },
  {
    name: "resize_page",
    description:
      "Resize the page viewport via Emulation.setDeviceMetricsOverride (width/height in CSS px). The override persists while the debugger stays attached; clear:true removes it.",
    schema: { tabId, width: z.number().int().positive().optional(), height: z.number().int().positive().optional(), clear: z.boolean().optional() },
  },
  {
    name: "wait_for",
    description:
      "Poll the page innerText until text appears or timeout (ms) elapses. text accepts a string or an array — an array resolves with the first alternative found (matched in the result).",
    schema: { text: z.union([z.string(), z.array(z.string()).min(1)]), timeout: z.number().int().optional(), tabId },
  },
];

// output_path: el payload pesado va a archivo y la respuesta queda {path, bytes}.
// Campo por tool: screenshot.image es base64, get_network_body.body lo es cuando
// base64Encoded viene true; snapshot/find/read_text son texto plano.
const OUTPUT_FIELDS = {
  screenshot: "image",
  snapshot: "snapshot",
  find: "snapshot",
  read_text: "text",
  get_network_body: "body",
};

// Devuelve el resultado reescrito, o null si la tool/args no aplican.
// writeFileSync puede lanzar: el caller lo envuelve en el error envelope.
export function outputToFile(tool, args, result) {
  const field = OUTPUT_FIELDS[tool];
  const path = typeof args?.output_path === "string" ? args.output_path : null;
  if (!field || !path || !result || typeof result[field] !== "string") return null;
  const base64 = tool === "screenshot" || result.base64Encoded === true;
  const buf = Buffer.from(result[field], base64 ? "base64" : "utf8");
  writeFileSync(path, buf);
  const out = { ...result };
  delete out[field];
  return { ...out, path, bytes: buf.length };
}

export function registerTools(server, call) {
  for (const { name, description, schema } of TOOLS) {
    server.tool(name, description, schema, async (args) => call(name, args ?? {}));
  }
}
