import { z } from "zod";

const tabId = z.number().int().optional();
const ref = z.union([z.string(), z.number()]);

export const TOOLS = [
  { name: "browser_status", description: "Report bridge connection and attached tabs.", schema: {} },
  {
    name: "list_tabs",
    description: "List open tabs with id, title and url.",
    schema: {},
  },
  {
    name: "new_tab",
    description: "Open a new active tab, optionally at a URL.",
    schema: { url: z.string().optional() },
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
    description: "Navigate to a URL in the tab and wait for the load to finish.",
    schema: { url: z.string(), tabId },
  },
  {
    name: "snapshot",
    description:
      "Accessibility tree of the page as text, with [ref] markers on interactive elements. Options: selector scopes to a subtree, interactive_only drops text lines, in_viewport_only keeps only visible-on-screen elements, max_chars caps output (default 20000), frame scopes to an embedded out-of-process iframe (frameId or url substring from list_frames; its origin must be allowlisted). Sensitive fields (passwords, card and identity numbers) appear redacted with a sensitive=<reason> marker and reject agent input with human_takeover_required.",
    schema: {
      tabId,
      selector: z.string().optional(),
      interactive_only: z.boolean().optional(),
      in_viewport_only: z.boolean().optional(),
      max_chars: z.number().int().positive().optional(),
      frame: z.string().optional(),
    },
  },
  {
    name: "find",
    description:
      "Find interactive elements by accessible-name text (substring, case-insensitive) and/or role (button, link, textbox, combobox, checkbox, radio...). Optional selector scopes the search. Returns matching [ref] lines only — refs are usable with click/type/etc.",
    schema: {
      text: z.string().optional(),
      role: z.string().optional(),
      selector: z.string().optional(),
      frame: z.string().optional(),
      tabId,
    },
  },
  {
    name: "read_text",
    description:
      "innerText of the element matching the CSS selector (defaults to body). Scrolls to bottom first to hydrate lazy sections; scroll:false skips it. Read-only.",
    schema: { selector: z.string().optional(), max: z.number().int().optional(), scroll: z.boolean().optional(), frame: z.string().optional(), tabId },
  },
  {
    name: "list_frames",
    description:
      "List the tab's frame tree: frameId, url, parent, oopif flag, sessionId and whether the frame's origin is allowed by the tab's origin allowlist. An out-of-process iframe is only reachable when its origin is allowlisted for the attached origin (same rule as an SSO redirect — see ~/.config/opencode-chrome/policy.json). Pass its frameId or a unique url substring as `frame` to snapshot/find/read_text.",
    schema: { tabId },
  },
  {
    name: "click",
    description: "Click the element captured with the given ref in the latest snapshot.",
    schema: { ref, tabId },
  },
  {
    name: "hover",
    description:
      "Move the pointer over the element with the given ref (trusted mouseMoved over CDP). Useful for menus and tooltips.",
    schema: { ref, tabId },
  },
  {
    name: "drag",
    description:
      "Drag the element with ref `from` onto the element with ref `to`, as a trusted press-move-release mouse sequence.",
    schema: { from: ref, to: ref, tabId },
  },
  {
    name: "type",
    description:
      "Type text into the element with the given ref; a trailing newline sends Enter.",
    schema: { ref, text: z.string(), tabId },
  },
  {
    name: "fill",
    description:
      "Set the value of an input, textarea or contenteditable in one shot. Uses the native property setter so React/Vue controlled fields keep it, then verifies by reading the value back. Prefer over type when no autocomplete is involved.",
    schema: { ref, value: z.string(), tabId },
  },
  {
    name: "select",
    description:
      "Pick an <option> on a <select> by label or value, then dispatch input/change. On failure the error lists the available options.",
    schema: { ref, option: z.string(), tabId },
  },
  {
    name: "scroll",
    description:
      "Scroll the page. With ref, scrolls that element into view; with dx/dy, scrolls the window by that many pixels (default dy 600 down). Returns the new position and at_bottom.",
    schema: { ref: ref.optional(), dx: z.number().optional(), dy: z.number().optional(), tabId },
  },
  {
    name: "upload",
    description:
      "Set local file paths on a <input type=file> via DOM.setFileInputFiles. files are absolute paths on the machine running Chrome.",
    schema: { ref, files: z.array(z.string()).min(1), tabId },
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
    name: "get_network_body",
    description:
      "Fetch the response body of a requestId seen in list_network. Text bodies over ~200KB are truncated; binary comes back base64Encoded.",
    schema: { requestId: z.string(), tabId },
  },
  {
    name: "screenshot",
    description:
      "Capture a PNG screenshot of the tab, returned as base64. annotate:true overlays [N] badges on the elements matching the latest snapshot refs, so the image lines up with ref numbers.",
    schema: { tabId, annotate: z.boolean().optional() },
  },
  {
    name: "wait_download",
    description:
      "Wait for a browser download to finish (timeout_ms, default 30000). Returns the saved path, bytes, mime, source url and a sha256 of the file computed by the bridge. Downloads are global to the browser (not per-tab) and land in the user's normal download directory. Requires an attached tab.",
    schema: { timeout_ms: z.number().int().positive().optional(), tabId },
  },
  {
    name: "wait_for",
    description:
      "Poll the page innerText until the given text appears or timeout (ms) elapses.",
    schema: { text: z.string(), timeout: z.number().int().optional(), tabId },
  },
];

export function registerTools(server, call) {
  for (const { name, description, schema } of TOOLS) {
    server.tool(name, description, schema, async (args) => call(name, args ?? {}));
  }
}
