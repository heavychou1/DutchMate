const DEFAULT_SETTINGS = {
  provider: "server",
  serverBaseUrl: "http://127.0.0.1:8787",
  openaiModel: "gpt-4.1-mini",
  openaiTtsModel: "gpt-4o-mini-tts",
  openaiTtsVoice: "coral",
  targetLanguage: "English",
  resumeAfterHover: false
};

// The API key is a secret, so it lives in storage.local (never synced).
const LOCAL_DEFAULTS = { openaiApiKey: "", serverApiToken: "" };

const syncFields = ["provider", "serverBaseUrl", "openaiModel", "openaiTtsModel", "openaiTtsVoice", "targetLanguage", "resumeAfterHover"];
const localFields = ["openaiApiKey", "serverApiToken"];

init();

async function init() {
  const [settings, localSettings] = await Promise.all([
    chrome.storage.sync.get(DEFAULT_SETTINGS),
    chrome.storage.local.get(LOCAL_DEFAULTS)
  ]);
  applyFields(syncFields, settings);
  applyFields(localFields, localSettings);
  document.getElementById("save").addEventListener("click", save);
}

function applyFields(list, values) {
  for (const field of list) {
    const el = document.getElementById(field);
    if (!el) continue;
    if (el.type === "checkbox") el.checked = !!values[field];
    else el.value = values[field] || "";
  }
}

function collectFields(list) {
  const out = {};
  for (const field of list) {
    const el = document.getElementById(field);
    if (!el) continue;
    out[field] = el.type === "checkbox" ? el.checked : el.value;
  }
  return out;
}

async function save() {
  await Promise.all([
    chrome.storage.sync.set(collectFields(syncFields)),
    chrome.storage.local.set(collectFields(localFields))
  ]);
  const status = document.getElementById("status");
  status.textContent = "Saved";
  setTimeout(() => { status.textContent = ""; }, 1800);
}
