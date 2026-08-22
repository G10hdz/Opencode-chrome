const input = document.getElementById("token");
const status = document.getElementById("status");
const conn = document.getElementById("conn");

function renderConn(connected) {
  conn.textContent = connected ? "● connected" : "○ not connected";
  conn.style.color = connected ? "#2e7d32" : "#999";
}

async function refreshConn() {
  try {
    const res = await chrome.runtime.sendMessage("status");
    renderConn(!!res && res.connected);
  } catch {
    renderConn(false); // service worker asleep or not responding
  }
}

chrome.storage.local.get("token").then(({ token }) => {
  input.value = token || "";
});
refreshConn();
setInterval(refreshConn, 2000);

document.getElementById("save").addEventListener("click", async () => {
  await chrome.storage.local.set({ token: input.value.trim() });
  status.textContent = "saved";
  // reconecta ya en vez de esperar la alarm de 1 min
  try {
    await chrome.runtime.sendMessage("reconnect");
  } catch {}
  setTimeout(refreshConn, 500);
});
