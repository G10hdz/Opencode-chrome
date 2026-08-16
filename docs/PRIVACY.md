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
- The bridge binds to `127.0.0.1` only and rejects non-extension WebSocket
  origins.

Use of the `chrome.debugger` permission is limited to executing the
documented tools (navigate, snapshot, click, type, screenshot, wait_for) in
the tab the agent is operating on, and the debugger detaches automatically
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
- El puente escucha únicamente en `127.0.0.1` y rechaza orígenes que no sean
  extensiones.

El uso del permiso `chrome.debugger` se limita a ejecutar las herramientas
documentadas (navigate, snapshot, click, type, screenshot, wait_for) en la
pestaña sobre la que opera el agente; el debugger se desacopla solo tras 30
segundos de inactividad.
