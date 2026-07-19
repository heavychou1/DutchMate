const DEFAULT_SETTINGS = {
  enabled: true,
  targetLanguage: "English",
  explanationDepth: "simple",
  pauseOnHover: true,
  resumeAfterHover: false,
  replaceNativeSubtitles: true,
  provider: "local",
  openaiModel: "gpt-4.1-mini",
  openaiTtsModel: "gpt-4o-mini-tts",
  openaiTtsVoice: "coral"
};

// Secrets are kept in storage.local so they are never synced to the account.
const LOCAL_DEFAULTS = { openaiApiKey: "" };

const speechCache = new Map();

chrome.runtime.onInstalled.addListener(async () => {
  const existing = await chrome.storage.sync.get(Object.keys(DEFAULT_SETTINGS));
  await chrome.storage.sync.set({ ...DEFAULT_SETTINGS, ...existing });
  await migrateApiKey();
});

async function migrateApiKey() {
  const synced = await chrome.storage.sync.get("openaiApiKey");
  if (typeof synced.openaiApiKey !== "string" || !synced.openaiApiKey) return;
  const local = await chrome.storage.local.get("openaiApiKey");
  if (!local.openaiApiKey) await chrome.storage.local.set({ openaiApiKey: synced.openaiApiKey });
  await chrome.storage.sync.remove("openaiApiKey");
}

async function getSettings() {
  const [synced, local] = await Promise.all([
    chrome.storage.sync.get(DEFAULT_SETTINGS),
    chrome.storage.local.get(LOCAL_DEFAULTS)
  ]);
  return { ...synced, ...local };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "GET_SETTINGS") {
    chrome.storage.sync.get(DEFAULT_SETTINGS).then(sendResponse);
    return true;
  }

  if (message.type === "SAVE_SETTINGS") {
    chrome.storage.sync.set(message.settings || {}).then(() => sendResponse({ ok: true }));
    return true;
  }

  if (message.type === "FETCH_TEXT") {
    fetchText(message.url).then(sendResponse);
    return true;
  }

  if (message.type === "EXPLAIN_TEXT") {
    explainText(message.payload).then(sendResponse);
    return true;
  }

  if (message.type === "GENERATE_SPEECH") {
    generateSpeech(message.payload).then(sendResponse);
    return true;
  }
});

async function fetchText(url) {
  try {
    const response = await fetch(url, { credentials: credentialsForUrl(url) });
    const text = await response.text();
    return {
      ok: response.ok,
      status: response.status,
      url: response.url,
      contentType: response.headers.get("content-type") || "",
      text
    };
  } catch (error) {
    return { ok: false, error: String(error && error.message ? error.message : error) };
  }
}

function credentialsForUrl(url) {
  try {
    const { hostname } = new URL(url);
    if (
      hostname === "npo.nl" ||
      hostname === "www.npo.nl" ||
      hostname.endsWith(".npoplayer.nl") ||
      hostname.endsWith(".streamgate.nl")
    ) {
      return "include";
    }
  } catch (_) {}
  return "omit";
}

async function explainText(payload) {
  const settings = await getSettings();
  const cached = await readCachedExplanation(payload, settings);
  if (cached) return cached;

  let result;
  if (settings.provider === "openai" && settings.openaiApiKey) {
    result = await explainWithOpenAI(payload, settings);
  } else {
    result = explainLocally(payload, settings);
  }

  await writeCachedExplanation(payload, settings, result);
  return result;
}

async function explainWithOpenAI(payload, settings) {
  const targetWord = payload.targetWord ? `Target word: ${payload.targetWord}` : "Target: whole subtitle";
  const contextBefore = (payload.previous || []).join("\n");
  const contextAfter = (payload.next || []).join("\n");
  const prompt = [
    "You are a concise Dutch tutor for video subtitles.",
    `Explain in ${settings.targetLanguage}.`,
    `Depth: ${settings.explanationDepth}.`,
    "Return compact JSON with exactly these keys:",
    `- "translation": the meaning of the target in ${settings.targetLanguage} (a string).`,
    `- "sentence": the FULL current subtitle translated into ${settings.targetLanguage} (a string).`,
    `- "note": a short usage note in ${settings.targetLanguage} (a string).`,
    `- "grammar": a short grammar explanation in ${settings.targetLanguage} (a string).`,
    `- "words": array of { "dutch": Dutch word, "translation": ${settings.targetLanguage} meaning, "note": optional ${settings.targetLanguage} note }.`,
    `- "examples": array of { "nl": an example sentence written in DUTCH, "target": that sentence translated into ${settings.targetLanguage} }.`,
    `Every "nl" field and every "dutch" field must be in Dutch. Only "translation", "note", "grammar", and "target" are in ${settings.targetLanguage}.`,
    "",
    targetWord,
    `Current subtitle: ${payload.subtitle}`,
    `Previous subtitles:\n${contextBefore}`,
    `Next subtitles:\n${contextAfter}`
  ].join("\n");

  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${settings.openaiApiKey}`
      },
      body: JSON.stringify({
        model: settings.openaiModel || "gpt-4.1-mini",
        input: prompt,
        text: { format: { type: "json_object" } }
      })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error && data.error.message ? data.error.message : "OpenAI request failed");
    const text = data.output_text || extractResponseText(data);
    const parsed = JSON.parse(text);
    return normalizeExplanation(parsed, "openai");
  } catch (error) {
    const fallback = explainLocally(payload, settings);
    fallback.note = `Local fallback: ${fallback.note}`;
    fallback.error = String(error && error.message ? error.message : error);
    return fallback;
  }
}

function extractResponseText(data) {
  const parts = [];
  for (const item of data.output || []) {
    for (const content of item.content || []) {
      if (content.text) parts.push(content.text);
    }
  }
  return parts.join("\n");
}

function explainLocally(payload, settings) {
  const word = cleanToken(payload.targetWord || "");
  const dictionary = {
    ik: "I",
    jij: "you",
    je: "you / your",
    hij: "he",
    zij: "she / they",
    we: "we",
    wij: "we",
    ze: "she / they",
    het: "it / the",
    de: "the",
    een: "a / one",
    en: "and",
    maar: "but / just",
    ook: "also / too",
    niet: "not",
    geen: "no / not any",
    wel: "does / indeed / actually",
    er: "there / it / unstressed reference word",
    hier: "here",
    daar: "there",
    vandaag: "today",
    morgen: "tomorrow",
    gisteren: "yesterday",
    nieuws: "news",
    mensen: "people",
    jaar: "year",
    dag: "day",
    gaat: "goes / is going",
    gaan: "to go",
    komt: "comes",
    komen: "to come",
    zegt: "says",
    zeggen: "to say",
    moet: "must / has to",
    moeten: "must / have to",
    kan: "can",
    kunnen: "can / be able to",
    omdat: "because",
    als: "if / when",
    voor: "for / before",
    met: "with",
    naar: "to / towards",
    van: "from / of",
    in: "in",
    op: "on",
    bij: "at / near / with",
    door: "through / by",
    over: "about / over"
  };

  const phraseNotes = [
    ["geen zin in", "The phrase 'ergens geen zin in hebben' means 'to not feel like it'."],
    ["aan het", "'aan het' plus infinitive often means an action is happening right now."],
    ["er zijn", "'er zijn' means 'there are'."],
    ["het gaat om", "'het gaat om' means 'it concerns' or 'it is about'."]
  ];
  const lowerSubtitle = (payload.subtitle || "").toLowerCase();
  const phrase = phraseNotes.find(([needle]) => lowerSubtitle.includes(needle));

  const translation = word && dictionary[word] ? dictionary[word] : "";
  return normalizeExplanation({
    translation: payload.targetWord ? translation || `No local dictionary entry for "${payload.targetWord}".` : "Add an OpenAI API key for full subtitle translation.",
    note: phrase ? phrase[1] : "Local mode gives basic hints only. Add an API key in the extension options for context-aware translation and grammar.",
    words: word ? [{ dutch: payload.targetWord, translation: translation || "unknown", note: "Context may change the meaning." }] : [],
    grammar: phrase ? phrase[1] : "",
    examples: []
  }, settings.provider === "openai" ? "local-fallback" : "local");
}

function normalizeExplanation(value, source) {
  const data = value && typeof value === "object" ? value : {};
  return {
    source,
    translation: toText(data.translation),
    sentence: toText(data.sentence),
    note: toText(data.note),
    words: normalizeWords(data.words),
    grammar: toText(data.grammar),
    examples: normalizeExamples(data.examples)
  };
}

function toText(value) {
  if (value == null) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map(toText).filter(Boolean).join("; ");
  if (typeof value === "object") {
    if (typeof value.text === "string") return value.text.trim();
    if (typeof value.explanation === "string") return value.explanation.trim();
    if (typeof value.value === "string") return value.value.trim();
    return Object.entries(value)
      .map(([key, item]) => {
        const text = toText(item);
        return text ? `${key}: ${text}` : "";
      })
      .filter(Boolean)
      .join("; ");
  }
  return "";
}

function normalizeWords(words) {
  if (!Array.isArray(words)) return [];
  return words
    .map((word) => {
      if (typeof word === "string") {
        const [dutch, ...rest] = word.split(/[:=]|\s-\s/);
        return { dutch: (dutch || "").trim(), translation: rest.join(" ").trim(), note: "" };
      }
      if (!word || typeof word !== "object") return null;
      return {
        dutch: toText(word.dutch ?? word.word ?? word.nl ?? word.term ?? word.source),
        translation: toText(word.translation ?? word.meaning ?? word.english ?? word.target ?? word.definition ?? word.gloss),
        note: toText(word.note ?? word.notes ?? word.comment)
      };
    })
    .filter((word) => word && (word.dutch || word.translation))
    .slice(0, 8);
}

function normalizeExamples(examples) {
  if (!Array.isArray(examples)) return [];
  return examples
    .map((example) => {
      if (typeof example === "string") return { nl: example.trim(), target: "" };
      if (!example || typeof example !== "object") return null;
      return {
        nl: toText(example.nl ?? example.dutch ?? example.source ?? example.text),
        target: toText(example.target ?? example.translation ?? example.english ?? example.meaning)
      };
    })
    .filter((example) => example && (example.nl || example.target))
    .slice(0, 3);
}

function cleanToken(token) {
  return String(token || "").toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
}

async function readCachedExplanation(payload, settings) {
  const key = cacheKey(payload, settings);
  const data = await chrome.storage.local.get(key);
  return data[key] || null;
}

async function writeCachedExplanation(payload, settings, result) {
  const key = cacheKey(payload, settings);
  await chrome.storage.local.set({ [key]: result });
}

function cacheKey(payload, settings) {
  const target = payload.targetWord || "__line__";
  const text = payload.subtitle || "";
  return `explain:v4:${settings.provider}:${settings.targetLanguage}:${settings.explanationDepth}:${target}:${text}`.slice(0, 750);
}

async function generateSpeech(payload) {
  const settings = await getSettings();
  const text = cleanSpeechText(payload && payload.text);
  const speed = clampSpeed(payload && payload.speed);
  if (!text) return { ok: false, error: "No text to pronounce." };
  if (!settings.openaiApiKey) return { ok: false, error: "No OpenAI API key configured." };

  const model = settings.openaiTtsModel || "gpt-4o-mini-tts";
  const voice = settings.openaiTtsVoice || "coral";
  const key = `speech:${model}:${voice}:${speed}:${text}`;
  if (speechCache.has(key)) return { ok: true, ...speechCache.get(key), cached: true };

  try {
    const requestBody = {
      model,
      voice,
      input: text,
      response_format: "mp3",
      speed
    };
    if (!/^tts-1(?:-hd)?$/i.test(model)) {
      requestBody.instructions = "Pronounce this as standard Netherlands Dutch. Speak clearly for a Dutch language learner.";
    }

    const response = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${settings.openaiApiKey}`
      },
      body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
      let message = "OpenAI TTS request failed.";
      try {
        const errorData = await response.json();
        message = errorData.error && errorData.error.message ? errorData.error.message : message;
      } catch (_) {}
      throw new Error(message);
    }

    const contentType = response.headers.get("content-type") || "audio/mpeg";
    const audioBase64 = arrayBufferToBase64(await response.arrayBuffer());
    const result = { contentType, audioDataUrl: `data:${contentType};base64,${audioBase64}` };
    speechCache.set(key, result);
    if (speechCache.size > 80) speechCache.delete(speechCache.keys().next().value);
    return { ok: true, ...result, cached: false };
  } catch (error) {
    return { ok: false, error: String(error && error.message ? error.message : error) };
  }
}

function cleanSpeechText(text) {
  return String(text || "").replace(/\s+/g, " ").trim().slice(0, 4096);
}

function clampSpeed(speed) {
  const value = Number(speed);
  if (!Number.isFinite(value)) return 1;
  return Math.min(4, Math.max(0.25, value));
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 32768;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.slice(i, i + chunkSize));
  }
  return btoa(binary);
}
