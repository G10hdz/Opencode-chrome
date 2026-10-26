// Side panel = terminal del chat. Todo el modelo y el loop viven en el bridge;
// aquí solo van texto del usuario y renders de los frames chat_*.
// Los frames viajan por un Port al service worker, que los reenvía al WS.

const log = document.getElementById("log");
const input = document.getElementById("input");
const sendBtn = document.getElementById("send");
const ctx = document.getElementById("ctx");

let port = null;
let turnId = 0;
let currentAssistant = null;
let tabId = null;

function el(cls, text) {
  const div = document.createElement("div");
  div.className = `msg ${cls}`;
  if (text !== undefined) div.textContent = text;
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
  return div;
}

function connect() {
  port = chrome.runtime.connect({ name: "opencode-chat" });
  port.onMessage.addListener(onFrame);
  port.onDisconnect.addListener(() => {
    port = null;
    el("error", "worker disconnected; reconnecting…");
    setTimeout(connect, 1000);
  });
  port.postMessage({ chat_init: true });
}

function onFrame(msg) {
  if (msg.chat_context) {
    const tabs = msg.chat_context.tabs ?? [];
    if (tabs.length) {
      tabId = tabs[0].id;
      const names = tabs.map((t) => t.title || t.url).join(" · ").slice(0, 140);
      ctx.innerHTML = `attached: <b>${escapeHtml(names)}</b>`;
    } else {
      tabId = null;
      ctx.textContent = "attach a tab with the extension icon to start";
    }
    return;
  }
  if (msg.chat_delta) {
    if (!currentAssistant) currentAssistant = el("assistant", "");
    currentAssistant.textContent += msg.chat_delta.text ?? "";
    log.scrollTop = log.scrollHeight;
    return;
  }
  if (msg.chat_tool) {
    const { phase, summary } = msg.chat_tool;
    const mark = phase === "call" ? "→" : phase === "result" ? "✓" : phase === "denied" ? "⊘" : "✗";
    el(`tool ${phase === "error" ? "error" : phase === "denied" ? "denied" : ""}`, `${mark} ${summary ?? ""}`);
    return;
  }
  if (msg.chat_confirm) {
    showConfirm(msg.chat_confirm);
    return;
  }
  if (msg.chat_error) {
    currentAssistant = null;
    el("error", msg.chat_error.message ?? "chat error");
    return;
  }
  if (msg.chat_done) {
    currentAssistant = null;
    if (msg.chat_done.truncated)
      el("muted", `— ended: ${msg.chat_done.truncated} —`);
    return;
  }
}

function showConfirm(c) {
  const box = el("confirm", "");
  const p = document.createElement("p");
  p.textContent = c.prompt ?? `Allow ${c.tool}?`;
  const code = document.createElement("code");
  code.textContent = JSON.stringify(c.args ?? {}).slice(0, 300);
  const yes = document.createElement("button");
  yes.textContent = "Approve";
  const no = document.createElement("button");
  no.textContent = "Deny";
  const answer = (approved) => {
    port?.postMessage({ chat_answer: { id: c.id, cid: c.cid, approved } });
    box.remove();
  };
  yes.onclick = () => answer(true);
  no.onclick = () => answer(false);
  box.append(p, code, document.createElement("br"), yes, no);
  log.scrollTop = log.scrollHeight;
}

function send() {
  const text = input.value.trim();
  if (!text || !port) return;
  el("user", text);
  input.value = "";
  currentAssistant = null;
  const frame = { chat: { id: ++turnId, text } };
  if (typeof tabId === "number") frame.chat.tabId = tabId;
  port.postMessage(frame);
}

function escapeHtml(s) {
  const span = document.createElement("span");
  span.textContent = s;
  return span.innerHTML;
}

sendBtn.onclick = send;
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    send();
  }
});

connect();
