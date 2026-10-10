const list = document.getElementById("list");

function row(session) {
  const button = document.createElement("button");
  button.type = "button";
  const name = session.name && session.name !== String(session.port) ? session.name : "";
  button.textContent = name ? `${name} · ${session.port}` : String(session.port);
  button.addEventListener("click", async () => {
    await chrome.runtime.sendMessage({ attach: session.port });
    window.close();
  });
  list.appendChild(button);
}

chrome.runtime.sendMessage("sessions").then((res) => {
  const sessions = Array.isArray(res?.sessions) ? res.sessions : [];
  if (!sessions.length) {
    const empty = document.createElement("p");
    empty.textContent = "No session is connected.";
    list.appendChild(empty);
    return;
  }
  for (const session of sessions) row(session);
});
