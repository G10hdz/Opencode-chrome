const input = document.getElementById("token");
const status = document.getElementById("status");

chrome.storage.local.get("token").then(({ token }) => {
  input.value = token || "";
});

document.getElementById("save").addEventListener("click", async () => {
  await chrome.storage.local.set({ token: input.value.trim() });
  status.textContent = "saved";
});
