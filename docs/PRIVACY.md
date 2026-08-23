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
- The bridge binds to `127.0.0.1` only, rejects non-extension WebSocket
  origins, and requires a shared token between the bridge and the extension.
  The only data stored persistently is that token, in `chrome.storage.local`
  (extension) and `~/.config/opencode-chrome/token` (bridge). Attached tab IDs
  and exact origins are kept in `chrome.storage.session` and clear with the
  browser session.

Use of the `chrome.debugger` permission is limited to executing the
documented tools (navigate, snapshot, click, type, screenshot, wait_for) in
a tab the user explicitly attached, and the debugger detaches automatically
after 30 seconds idle.

## Español

La extensión y el puente opencode-chrome no recolectan, guardan ni
transmiten datos personales a nadie. No hay backend ni analítica.

- La extensión se comunica solo con un WebSocket en `127.0.0.1` (tu propia
  máquina), iniciado por el puente npm `opencode-chrome`.
- El contenido de páginas, snapshots, capturas y metadatos de pestañas que
  procesan las herramientas van del navegador al puente local y de ahí al
  cliente MCP (opencode) que configuraste, que los trata según los términos
  de tu proveedor de modelos. Nosotros nunca los vemos.
- El puente escucha únicamente en `127.0.0.1`, rechaza orígenes que no sean
  extensiones y exige un token compartido entre puente y extensión. Lo único
  que se guarda de forma persistente es ese token: en `chrome.storage.local`
  (extensión) y `~/.config/opencode-chrome/token` (puente). Los IDs y orígenes
  exactos de pestañas adjuntas viven en `chrome.storage.session` y se borran
  con la sesión del navegador.

El uso del permiso `chrome.debugger` se limita a ejecutar las herramientas
documentadas (navigate, snapshot, click, type, screenshot, wait_for) en una
pestaña que el usuario adjuntó explícitamente; el debugger se desacopla tras 30
segundos de inactividad.
