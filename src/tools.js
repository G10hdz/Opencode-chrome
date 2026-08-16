import { z } from "zod";

const tabId = z.number().int().optional();
const ref = z.union([z.string(), z.number()]);

export const TOOLS = [
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
      "Accessibility tree of the page as text, with [ref] markers on interactive elements.",
    schema: { tabId },
  },
  {
    name: "click",
    description: "Click the element captured with the given ref in the latest snapshot.",
    schema: { ref, tabId },
  },
  {
    name: "type",
    description:
      "Type text into the element with the given ref; a trailing newline sends Enter.",
    schema: { ref, text: z.string(), tabId },
  },
  {
    name: "screenshot",
    description: "Capture a PNG screenshot of the tab, returned as base64.",
    schema: { tabId },
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
