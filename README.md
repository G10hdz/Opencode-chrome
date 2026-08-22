# opencode-chrome

Let [opencode](https://opencode.ai) drive your real Chrome: your logged-in
sessions, your cookies, your tabs. An unofficial, community-built bridge in
the spirit of Claude in Chrome / Codex in Chrome.

> **Unofficial.** Not affiliated with or endorsed by the opencode project.
> BYOK: your model keys stay in your opencode config. This bridge collects
> nothing and talks only to localhost.

## How it works

```
opencode (terminal, your keys)
   │ MCP stdio
opencode-chrome (npm bridge)         ← MCP server + WebSocket on 127.0.0.1:9223
   │ WebSocket
opencode-chrome (extension)          ← MV3 service worker
   │ chrome.debugger (CDP)
your real Chrome
```

No backend, no accounts. The extension connects to the bridge on localhost
and executes browser tools over the Chrome DevTools Protocol.

## Install

**1. Extension** — download the repo (or the [latest
release](../../releases)), open `chrome://extensions`, enable Developer
mode, "Load unpacked", select the `extension/` folder. The toolbar badge
shows `off` until the token is configured and the bridge is running.

**2. Bridge** — add to your opencode config (`opencode.json`):

```json
{
  "mcp": {
    "chrome": { "type": "local", "command": ["npx", "-y", "opencode-chrome"] }
  }
}
```

**3. Pair the token** — the bridge generates a token at
`~/.config/opencode-chrome/token` (or prints it to stderr at startup; set
`OPENCODE_CHROME_TOKEN` to use your own). Paste it into the extension's
options page (right-click the toolbar icon → Options). Connections without
this token are refused, so other local processes can't drive your browser.

**4. Use it** — restart opencode, then ask away: *"open gmail and list my
unread senders"*, *"go to the staging site and screenshot the checkout
form"*.

## Tools

| Tool | What it does |
|---|---|
| `list_tabs` | tabs with id, title, url |
| `new_tab(url?)` | open a tab (active) |
| `close_tab(id)` / `activate_tab(id)` | tab management |
| `navigate(url, tabId?)` | navigate and wait for load |
| `snapshot(tabId?)` | accessibility-style text tree with `[ref]` per interactive element |
| `click(ref)` | resolve ref and click |
| `type(ref, text)` | focus + type; trailing `\n` = Enter |
| `screenshot(tabId?)` | PNG (base64) |
| `wait_for(text, timeout?)` | poll page text until it appears |

## Notes

- While the agent acts, Chrome shows the "being debugged" banner. That is
  expected with CDP; the extension auto-detaches after 30s idle.
- Env vars for the bridge: `OPENCODE_CHROME_PORT` (default 9223, extension
  expects the default), `OPENCODE_CHROME_TIMEOUT_MS` (default 30000).
- Security: the WebSocket binds to 127.0.0.1 only, rejects non-extension
  origins, and requires the shared bridge/extension token. The only data
  stored locally is that token (in `chrome.storage.local`). Page content
  never leaves your machine through this bridge; it goes only to your model
  provider, exactly like any opencode prompt.

## Development

```bash
npm install
npm test        # bridge tests (node:test, no Chrome needed)
npm run pack    # builds dist/opencode-chrome-<version>.zip for CWS upload
```

Icons live in `extension/icons/`, sized from the 1024px masters in `assets/`:
`sips -z <size> <size> assets/logo-1024-transparent.png --out extension/icons/icon<size>.png`.

MIT license. See [LICENSE](LICENSE).

---

# opencode-chrome (español)

Deja que [opencode](https://opencode.ai) maneje tu Chrome real: tus sesiones
iniciadas, tus cookies, tus pestañas. Puente comunitario no oficial, al
estilo de Claude in Chrome / Codex in Chrome.

> **No oficial.** Sin afiliación con el proyecto opencode. BYOK: tus keys
> viven en tu config de opencode. Este puente no recolecta nada y solo se
> comunica con localhost.

## Instalación

1. **Extensión**: `chrome://extensions` → modo desarrollador → "Cargar
   descomprimida" → carpeta `extension/` del repo. El badge muestra `off`
   hasta configurar el token y correr el puente.
2. **Puente**: en tu `opencode.json`:
   ```json
   { "mcp": { "chrome": { "type": "local", "command": ["npx", "-y", "opencode-chrome"] } } }
   ```
3. **Token**: el puente genera uno en `~/.config/opencode-chrome/token`
   (o lo imprime por stderr al arrancar; `OPENCODE_CHROME_TOKEN` para usar
   el tuyo). Pegalo en la página de opciones de la extensión (click derecho
   en el ícono → Opciones). Sin ese token, las conexiones se rechazan.
4. Reinicia opencode y pedile cosas: *"abrí gmail y listá los remitentes no
   leídos"*.

Herramientas, notas de seguridad y desarrollo: ver sección en inglés arriba
(mismo contenido).
