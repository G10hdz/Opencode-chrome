# opencode-chrome

Puente MCP que deja a opencode controlar tu Chrome real (con sesiones logueadas)
a través de una extensión delgada. El patrón: opencode habla MCP por stdio con
este bin, el bin expone un WebSocket local en `127.0.0.1:9223`, y la extensión
Chrome MV3 se conecta a ese WS y ejecuta las acciones via Chrome DevTools
Protocol. Sin backend, sin credenciales en la extensión (BYOK: las keys viven
en la config de opencode).

## Instalación

1. Instalá y ejecutá el puente (queda escuchando en `ws://127.0.0.1:9223`):

   ```sh
   npm install -g opencode-chrome
   ```

   O usalo directo desde opencode sin instalación (ver paso 3).

2. Cargá la extensión: andá a `chrome://extensions`, activá "Developer mode",
   "Load unpacked" y seleccioná la carpeta `extension/` de este repo. El badge
   de la extensión se pone verde cuando conecta con el puente (gris mientras
   reconecta cada 3s).

3. Registrá el servidor MCP en tu `opencode.json`:

   ```json
   {
     "mcp": {
       "chrome": {
         "type": "local",
         "command": ["npx", "-y", "opencode-chrome"]
       }
     }
   }
   ```

## Tools

| tool | args | qué hace |
|---|---|---|
| `list_tabs` | | pestañas abiertas con id, título y url |
| `new_tab` | `url?` | abre pestaña nueva (activa) |
| `close_tab` | `id` | cierra la pestaña |
| `activate_tab` | `id` | enfoca la pestaña |
| `navigate` | `url, tabId?` | navega y espera la carga |
| `snapshot` | `tabId?` | árbol de accesibilidad en texto con marcadores `[ref]` |
| `click` | `ref, tabId?` | clickea el elemento con ese ref del último snapshot |
| `type` | `ref, text, tabId?` | escribe texto en el elemento; `\n` manda Enter |
| `screenshot` | `tabId?` | PNG en base64 |
| `wait_for` | `text, timeout?, tabId?` | pollea el innerText hasta que aparezca el texto |

Flujo típico: `list_tabs` o `new_tab` → `snapshot` → `click`/`type` con los
refs → `wait_for`/`screenshot` para verificar. Si una navegación invalida los
refs, re-hacé un snapshot.

## Variables de entorno

| variable | default | qué controla |
|---|---|---|
| `OPENCODE_CHROME_PORT` | `9223` | puerto del WS (siempre bindeado a 127.0.0.1) |
| `OPENCODE_CHROME_TIMEOUT_MS` | `30000` | timeout por llamada a la extensión |

## Notas

- El WS acepta solo conexiones con origin `chrome-extension://` (o sin origin,
  como los clientes de test no-navegador), y escucha únicamente en localhost.
- Mientras la extensión opera una pestaña, Chrome muestra el banner "Chrome is
  being debugged". Es normal: aparece al attach de CDP y desaparece solo cuando
  la extensión se desattacha (idle ~30s) o cerrás la pestaña.
- Si una tool falla con "Chrome extension not connected": abrí Chrome o
  recargá la extensión en `chrome://extensions`; el puente sigue corriendo y
  las tools vuelven a funcionar apenas reconecta.

## Desarrollo

```sh
npm install
npm test        # node --test test/
```

Estructura: `src/index.js` (servidor MCP stdio + WS server con multiplexado
por id y timeout), `src/tools.js` (definición y schemas de las tools),
`extension/` (MV3 service worker), `test/`.
