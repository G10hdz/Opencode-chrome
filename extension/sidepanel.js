// Side panel = terminal del chat. Todo el modelo y el loop viven en el bridge;
// aquí solo van texto del usuario y renders de los frames chat_*.
// Los frames viajan por un Port al service worker, que los reenvía al WS.
// La API key nunca se guarda en la extensión: el form solo la manda por el
// WS autenticado al bridge, que la escribe en chat.json.

const log = document.getElementById("log");
const input = document.getElementById("input");
const sendBtn = document.getElementById("send");
const ctx = document.getElementById("ctxtext");
const gear = document.getElementById("gear");
const settings = document.getElementById("settings");
const providerEl = document.getElementById("provider");
const effortEl = document.getElementById("effort");
const apikeyEl = document.getElementById("apikey");
const baseurlEl = document.getElementById("baseurl");
const modelEl = document.getElementById("model");
const modellistEl = document.getElementById("modellist");
const privacyEl = document.getElementById("privacy");
const savecfgBtn = document.getElementById("savecfg");
const cfgstatusEl = document.getElementById("cfgstatus");
const loadmodelsBtn = document.getElementById("loadmodels");

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
  // prefill de la config actual: si hay chat.json, regresa provider/model/effort
  // (y la lista de modelos); si no, regresa el error y el form queda vacío.
  port.postMessage({ chat_models: {} });
}

function showPrivacy(p) {
  if (!p?.note) {
    privacyEl.style.display = "none";
    return;
  }
  const mark = p.trains === false ? "✓" : p.trains === "unknown" ? "?" : "!";
  privacyEl.className =
    p.trains === false ? "" : p.trains === "unknown" ? "warn" : "bad";
  privacyEl.textContent = `${mark} ${p.note}`;
  privacyEl.style.display = "block";
}

function prefill(cfg) {
  if (!cfg) return;
  if (cfg.provider && providerEl.value !== cfg.provider) providerEl.value = cfg.provider;
  if (cfg.base_url && !baseurlEl.value) baseurlEl.value = cfg.base_url;
  if (cfg.model && !modelEl.value) modelEl.value = cfg.model;
  if (cfg.effort) effortEl.value = cfg.effort;
  if (cfg.has_key) apikeyEl.placeholder = "key saved — type to replace";
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
  if (msg.chat_models) {
    const { models = [], configured, error, privacy } = msg.chat_models;
    prefill(configured);
    showPrivacy(privacy);
    modellistEl.textContent = "";
    for (const m of models) {
      const opt = document.createElement("option");
      opt.value = m.id;
      opt.label = m.free ? `${m.label} · free` : m.label;
      modellistEl.appendChild(opt);
    }
    cfgstatusEl.textContent = error
      ? error
      : models.length
        ? `${models.length} models — free first`
        : "";
    return;
  }
  if (msg.chat_config) {
    prefill(msg.chat_config);
    showPrivacy(msg.chat_config.privacy);
    cfgstatusEl.textContent = `saved — ${msg.chat_config.provider} / ${msg.chat_config.model}`;
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
    if ((msg.chat_error.message ?? "").includes("chat_not_configured"))
      settings.classList.add("open");
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

function cfgFrame() {
  const frame = {
    provider: providerEl.value,
    model: modelEl.value.trim(),
    effort: effortEl.value,
    base_url: baseurlEl.value.trim(),
  };
  const key = apikeyEl.value.trim();
  if (key) frame.api_key = key;
  return frame;
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

gear.onclick = () => settings.classList.toggle("open");
loadmodelsBtn.onclick = () => {
  if (!port) return;
  cfgstatusEl.textContent = "loading…";
  const f = cfgFrame();
  port.postMessage({
    chat_models: { provider: f.provider, base_url: f.base_url, api_key: f.api_key },
  });
};
savecfgBtn.onclick = () => {
  if (!port) return;
  port.postMessage({ chat_config: cfgFrame() });
  apikeyEl.value = "";
};

connect();
