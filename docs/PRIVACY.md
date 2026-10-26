# Privacy Policy / Política de Privacidad

## English

The opencode-chrome extension and bridge collect, store, and transmit no
personal data to us. There is no backend and no analytics.

- The extension communicates only with a WebSocket on `127.0.0.1` (your own
  machine), started by the `opencode-chrome` npm bridge.
- Page content, snapshots, screenshots, and tab metadata processed by the
  tools are sent from your browser to the local bridge, and from there into
  the MCP client (opencode) you configured, which handles them according to
  your model provider's terms. We never see them.
- If you use the optional side-panel chat, the bridge sends tool results
  (page content) to the model provider configured in
  `~/.config/opencode-chrome/chat.json`, under your own API key. The key
  stays on your machine and never reaches the extension or the page.
- The bridge binds to `127.0.0.1` only, rejects non-extension WebSocket
  origins, and requires a shared token between the bridge and the extension.
  The only data stored persistently is that token, in `chrome.storage.local`
  (extension) and `~/.config/opencode-chrome/token` (bridge). Attached tab IDs
  and exact origins are kept in `chrome.storage.session` and clear with the
  browser session.

Use of the `chrome.debugger` permission is limited to executing the
documented tool set in a tab the user explicitly attached: navigating and
reading page structure and text; clicking, typing and filling forms;
screenshots; network, console and storage-key inspection; environment
emulation; dialogs; downloads. The debugger detaches automatically after
30 seconds idle.

## Español

La extensión y el puente opencode-chrome no recolectan, guardan ni
transmiten datos personales a nadie. No hay backend ni analítica.

- La extensión se comunica solo con un WebSocket en `127.0.0.1` (tu propia
  máquina), iniciado por el puente npm `opencode-chrome`.
- El contenido de páginas, snapshots, capturas y metadatos de pestañas que
  procesan las herramientas van del navegador al puente local y de ahí al
  cliente MCP (opencode) que configuraste, que los trata según los términos
  de tu proveedor de modelos. Nosotros nunca los vemos.
- Si usas el chat opcional del panel lateral, el puente manda los
  resultados de las herramientas (contenido de página) al proveedor de
  modelos configurado en `~/.config/opencode-chrome/chat.json`, con tu
  propia API key. La key se queda en tu máquina y nunca llega a la
  extensión ni a la página.
- El puente escucha únicamente en `127.0.0.1`, rechaza orígenes que no sean
  extensiones y exige un token compartido entre puente y extensión. Lo único
  que se guarda de forma persistente es ese token: en `chrome.storage.local`
  (extensión) y `~/.config/opencode-chrome/token` (puente). Los IDs y orígenes
  exactos de pestañas adjuntas viven en `chrome.storage.session` y se borran
  con la sesión del navegador.

El uso del permiso `chrome.debugger` se limita a ejecutar el conjunto de
herramientas documentadas en una pestaña que el usuario adjuntó
explícitamente: navegar y leer estructura y texto de la página; hacer clic,
escribir y llenar formularios; capturas; inspección de red, consola y
nombres de claves de almacenamiento; emulación de entorno; diálogos;
descargas. El debugger se desacopla tras 30 segundos de inactividad.
