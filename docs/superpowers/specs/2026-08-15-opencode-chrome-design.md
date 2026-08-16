# opencode-chrome — Design

Fecha: 2026-08-15
Estado: Aprobado (pendiente de implementación)

## Contexto

Queremos que opencode controle nuestro Chrome real (con sesiones logueadas),
equivalente a Claude in Chrome / Codex in Chrome. Requisitos: BYOK (las keys
viven en la config de opencode, la extensión nunca toca credenciales), sin
backend propio, sin overlay en página. Usos: automatizar apps con sesión
iniciada, investigación/browsing general, QA básico de apps propias. No
apunta a reemplazar scraping a escala (para eso está firecrawl).

## Decision

Extensión Chrome MV3 delgada + puente MCP local (patrón browser-tools-mcp /
chrome-devtools-mcp). El agente, models y keys son los de opencode CLI; la
extensión solo expone herramientas del navegador vía CDP.

### Arquitectura

```
terminal (opencode + keys del usuario)
   │ MCP stdio
opencode-chrome (bin npm)          ← servidor MCP + WS server en 127.0.0.1:9223
   │ WebSocket (JSON: {id, tool, args} → {id, result|error})
extensión MV3 (service worker)
   │ chrome.debugger (Chrome DevTools Protocol)
Chrome real del usuario (cookies/sesiones)
```

- Puente: JS ESM, sin build step. Bin `opencode-chrome`. Registro en
  `opencode.json`:
  ```json
  { "mcp": { "chrome": { "type": "local", "command": ["npx", "-y", "opencode-chrome"] } } }
  ```
- Seguridad del WS: bind 127.0.0.1 únicamente; validar `Origin` con prefijo
  `chrome-extension://`. Puerto configurable vía `OPENCODE_CHROME_PORT`
  (default 9223).
- Extensión: `background.js` (service worker) reconecta al WS cada 3s; badge
  gris = desconectado, verde = conectado. Sin popup ni content scripts.
- CDP: attach por tabId bajo demanda; auto-detach tras 30s idle para que el
  banner "Chrome is being debugged" desaparezca solo.

## Herramientas v1

| tool | comportamiento |
|---|---|
| `list_tabs` | pestañas con id, título, url |
| `new_tab(url?)` | abre pestaña (activa) |
| `close_tab(id)` | cierra pestaña |
| `activate_tab(id)` | enfoca pestaña |
| `navigate(url, tabId?)` | navega y espera carga |
| `snapshot(tabId?)` | árbol a11y en texto con `[ref]` por elemento interactivo |
| `click(ref)` | resuelve ref y hace click via CDP |
| `type(ref, text)` | focus + insertText; `\n` = Enter |
| `screenshot(tabId?)` | PNG base64 |
| `wait_for(text, timeout?)` | pollea innerText hasta timeout |

Snapshot: árbol filtrado (rol, nombre, valor, href) con refs estables por
navegación; el agente actúa por ref. Resolución ref→node via
`DOM.requestNode` + backendNodeId (no inyecta JS de localización en página,
menos frágil).

## Manejo de errores

- Extensión desconectada: toda tool devuelve error accionable ("abrí Chrome
  o recargá la extensión").
- Errores CDP se propagan con dominio y mensaje.
- Navegación durante acción: el agente re-snapshottea (no reintentos mágicos
  en el puente).
- Tab cerrada: error claro; el service worker no crashea.

## Testing

- `test/tools.test.js` con `node:test`: roundtrip WS con cliente fake
  (extensión simulada), validación de schemas, timeouts, caso desconectado.
- E2E manual: checklist con opencode real ("andá a gmail, listá no leídos").

## Estructura del repo

```
opencode-chrome/
  package.json
  src/index.js        (servidor MCP + WS)
  src/tools.js        (definición de tools y schemas)
  extension/manifest.json
  extension/background.js
  extension/icons/
  test/tools.test.js
```

## Fuera de alcance (v1)

Overlay en página, popup de UI, descarga de archivos, manejo de múltiples
ventanas, cookies/storage APIs, headers custom de red. BYOK no requiere
trabajo: hereda providers de opencode.
