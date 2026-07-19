const DEFAULT_SETTINGS = {
  enabled: true,
  targetLanguage: "English",
  explanationDepth: "simple",
  pauseOnHover: true,
  replaceNativeSubtitles: true
};

const fields = ["enabled", "targetLanguage", "explanationDepth", "pauseOnHover", "replaceNativeSubtitles"];

init();

async function init() {
  const settings = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  for (const field of fields) {
    const el = document.getElementById(field);
    if (el.type === "checkbox") el.checked = !!settings[field];
    else el.value = settings[field] || "";
    el.addEventListener("change", save);
    el.addEventListener("input", save);
  }
}

async function save() {
  const settings = {};
  for (const field of fields) {
    const el = document.getElementById(field);
    settings[field] = el.type === "checkbox" ? el.checked : el.value;
  }
  await chrome.storage.sync.set(settings);
}
