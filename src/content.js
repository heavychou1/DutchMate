(function () {
  const DEFAULT_SETTINGS = {
    enabled: true,
    targetLanguage: "English",
    explanationDepth: "simple",
    pauseOnHover: true,
    resumeAfterHover: false,
    replaceNativeSubtitles: true,
    provider: "local",
    openaiTtsModel: "gpt-4o-mini-tts",
    openaiTtsVoice: "coral"
  };

  const state = {
    settings: DEFAULT_SETTINGS,
    cues: [],
    currentCue: null,
    currentIndex: 0,
    lastRenderedKey: "",
    nativeText: "",
    player: null,
    video: null,
    layer: null,
    popup: null,
    toolbar: null,
    pausedByExtension: false,
    hidePopupTimer: null,
    pointerOverPopup: false,
    dutchVoice: null,
    currentPronunciationAudio: null,
    pronunciationRequestId: 0,
    sentenceReplayCancel: null,
    candidateUrls: new Set(),
    triedUrls: new Set(),
    invalidated: false,
    discoverInterval: null
  };

  init();

  async function init() {
    state.settings = await send({ type: "GET_SETTINGS" }).catch(() => DEFAULT_SETTINGS);
    applySettings();
    installMessageBridge();
    discoverFromPage();
    installStorageListener();
    initVoices();
    waitForPlayer();
    state.discoverInterval = setInterval(discoverFromPage, 4000);
  }

  function initVoices() {
    selectDutchVoice();
    if ("speechSynthesis" in window) {
      window.speechSynthesis.addEventListener("voiceschanged", selectDutchVoice);
    }
  }

  function selectDutchVoice() {
    if (!("speechSynthesis" in window)) return;
    const voices = window.speechSynthesis.getVoices();
    const dutchVoices = voices.filter((voice) => /^nl([-_]|$)/i.test(voice.lang || ""));
    state.dutchVoice = dutchVoices.sort(scoreVoice)[0] || null;
  }

  function scoreVoice(a, b) {
    return voiceScore(b) - voiceScore(a);
  }

  function voiceScore(voice) {
    const name = `${voice.name || ""} ${voice.voiceURI || ""}`.toLowerCase();
    let score = 0;
    if (/^nl[-_]nl$/i.test(voice.lang || "")) score += 50;
    if (voice.localService) score += 10;
    if (/google|microsoft|xander|claire|ellen|premium|enhanced|neural|natural/.test(name)) score += 8;
    if (/compact|basic/.test(name)) score -= 6;
    return score;
  }

  function installStorageListener() {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "sync") return;
      for (const [key, change] of Object.entries(changes)) state.settings[key] = change.newValue;
      applySettings();
      renderCue(true);
    });
  }

  function applySettings() {
    document.documentElement.classList.toggle("npo-study-hide-native", !!state.settings.replaceNativeSubtitles);
    if (state.layer) state.layer.hidden = !state.settings.enabled;
  }

  function installMessageBridge() {
    window.addEventListener("message", (event) => {
      if (event.source !== window || event.data?.source !== "npo-dutch-study-page-hook") return;
      if (event.data.type === "resource-url") addCandidateUrl(event.data.url);
      if (event.data.type === "resource-body") processBody(event.data.url, event.data.body, event.data.contentType);
    });
    window.postMessage({ source: "npo-dutch-study-content", type: "replay" }, window.location.origin);
  }

  function waitForPlayer() {
    const tick = () => {
      state.player = document.querySelector(".bitmovinplayer-container") || document.querySelector("video")?.parentElement;
      state.video = document.querySelector(".bitmovinplayer-container video") || document.querySelector("video");
      if (state.player && state.video) {
        ensureUi();
        observeNativeSubtitles();
        state.video.addEventListener("timeupdate", () => renderCue(false));
        state.video.addEventListener("seeked", () => renderCue(true));
        requestAnimationFrame(loop);
      } else {
        setTimeout(tick, 500);
      }
    };
    tick();
  }

  function ensureUi() {
    if (getComputedStyle(state.player).position === "static") state.player.style.position = "relative";

    if (!state.layer) {
      state.layer = document.createElement("div");
      state.layer.className = "npo-study-subtitle-layer";
      state.layer.dataset.empty = "true";
      state.player.appendChild(state.layer);
    }

    if (!state.popup) {
      state.popup = document.createElement("div");
      state.popup.className = "npo-study-popup";
      state.popup.hidden = true;
      state.popup.addEventListener("mouseenter", () => {
        state.pointerOverPopup = true;
        cancelHidePopup();
      });
      state.popup.addEventListener("mouseleave", () => {
        state.pointerOverPopup = false;
        scheduleHidePopup();
      });
      document.documentElement.appendChild(state.popup);
      document.addEventListener("keydown", (event) => {
        if (event.key === "Escape") hidePopup();
      });
    }

    if (!state.toolbar) {
      state.toolbar = document.createElement("div");
      state.toolbar.className = "npo-study-toolbar";
      state.toolbar.innerHTML = `
        <button class="npo-study-button" type="button" title="Toggle study subtitles">NL</button>
        <div class="npo-study-status" hidden></div>
      `;
      state.toolbar.querySelector("button").addEventListener("click", async () => {
        state.settings.enabled = !state.settings.enabled;
        await send({ type: "SAVE_SETTINGS", settings: { enabled: state.settings.enabled } }).catch(() => {});
        applySettings();
      });
      state.player.appendChild(state.toolbar);
    }

    applySettings();
    setStatus("Looking for subtitle data...");
  }

  function loop() {
    if (state.invalidated) return;
    renderCue(false);
    requestAnimationFrame(loop);
  }

  function discoverFromPage() {
    for (const script of document.querySelectorAll("script")) {
      const text = script.textContent || "";
      if (/subtitle|ondertiteling|textTrack|\.vtt|\.srt|ttml|caption/i.test(text)) processBody(location.href, text, script.type);
    }

    if (performance?.getEntriesByType) {
      for (const entry of performance.getEntriesByType("resource")) addCandidateUrl(entry.name);
    }

    for (const track of document.querySelectorAll("track[src]")) addCandidateUrl(track.src);
    tryCandidateUrls();
  }

  function addCandidateUrl(url) {
    if (!url || state.candidateUrls.has(url)) return;
    if (isThumbnailSubtitleUrl(url)) return;
    if (!/\.(vtt|srt)(?:\?|$)|ttml|subtitle|ondertitel|caption|texttrack/i.test(url)) return;
    state.candidateUrls.add(url);
    tryCandidateUrls();
  }

  async function tryCandidateUrls() {
    for (const url of [...state.candidateUrls]) {
      if (state.triedUrls.has(url)) continue;
      state.triedUrls.add(url);
      if (isThumbnailSubtitleUrl(url)) continue;
      const response = await send({ type: "FETCH_TEXT", url }).catch(() => null);
      if (response?.text) processBody(response.url || url, response.text, response.contentType);
    }
  }

  function processBody(url, body, contentType) {
    if (!body) return;
    const cueSets = [];

    if (/WEBVTT/i.test(body) || /\.vtt(?:\?|$)/i.test(url)) cueSets.push(parseVtt(body, url));
    if (/^\s*\d+\s*\n\d\d:\d\d:\d\d/i.test(body) || /\.srt(?:\?|$)/i.test(url)) cueSets.push(parseSrt(body, url));
    if (/<tt[\s>]|<ttml|begin=/i.test(body)) cueSets.push(parseTtml(body, url));

    if (/json|javascript|^https?:/i.test(contentType || url)) {
      const jsonCueSets = extractFromJsonLike(body, url);
      cueSets.push(...jsonCueSets);
    }

    const best = cueSets.filter((set) => set.length >= 3).sort((a, b) => b.length - a.length)[0];
    if (!best) return;

    if (isThumbnailSubtitleUrl(url) || !looksLikeSubtitleCueSet(best)) return;
    if (best.length > state.cues.length || !state.cues.length) {
      state.cues = best.sort((a, b) => a.start - b.start);
      state.currentIndex = 0;
      setStatus(`Loaded ${state.cues.length} subtitle cues.`);
      renderCue(true);
    }
  }

  function extractFromJsonLike(body, url) {
    const results = [];
    try {
      const json = JSON.parse(body);
      const urls = [];
      walk(json, (value) => {
        if (typeof value === "string" && /\.(vtt|srt)(?:\?|$)|ttml|subtitle|ondertitel|caption|texttrack/i.test(value)) {
          urls.push(new URL(value, location.href).href);
        }
      });
      urls.forEach(addCandidateUrl);
      results.push(...extractCueArrays(json, url));
    } catch (_) {
      const matches = body.match(/https?:[^"'\\\s<>]+(?:\.vtt|\.srt|ttml|subtitle|ondertitel|caption|texttrack)[^"'\\\s<>]*/gi) || [];
      matches.forEach((match) => addCandidateUrl(match.replace(/\\u0026/g, "&")));
    }
    return results;
  }

  function extractCueArrays(json, url) {
    const found = [];
    walk(json, (value) => {
      if (!Array.isArray(value) || value.length < 3) return;
      const entries = value.map((item) => {
        if (!item || typeof item !== "object") return null;
        const text = item.text || item.content || item.body || item.subtitle || item.caption;
        if (!text) return null;
        return {
          text: stripTags(String(text)),
          start: item.start ?? item.begin ?? item.from ?? item.startTime,
          end: item.end ?? item.to ?? item.endTime
        };
      });
      const scale = detectTimeScale(entries);
      const cues = entries.map((entry, index) => {
        if (!entry) return null;
        const start = toSeconds(entry.start, scale);
        const end = toSeconds(entry.end, scale);
        if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
        return { id: `${url}:${index}`, start, end, text: entry.text };
      }).filter(Boolean);
      if (cues.length >= 3) found.push(cues);
    });
    return found;
  }

  function detectTimeScale(entries) {
    const durations = [];
    for (const entry of entries) {
      if (!entry) continue;
      const start = Number(entry.start);
      const end = Number(entry.end);
      if (Number.isFinite(start) && Number.isFinite(end) && end > start) durations.push(end - start);
    }
    if (!durations.length) return 1;
    durations.sort((a, b) => a - b);
    const median = durations[Math.floor(durations.length / 2)];
    // Real subtitle cues last only a few seconds, so a median cue "length" in
    // the tens or hundreds means the raw numbers are milliseconds, not seconds.
    return median > 60 ? 1000 : 1;
  }

  function toSeconds(value, scale) {
    if (typeof value === "number") return Number.isFinite(value) ? value / scale : NaN;
    const text = String(value ?? "").trim();
    if (/^-?\d+(?:\.\d+)?$/.test(text)) return Number(text) / scale;
    return seconds(text);
  }

  function walk(value, visitor) {
    visitor(value);
    if (Array.isArray(value)) value.forEach((item) => walk(item, visitor));
    else if (value && typeof value === "object") Object.values(value).forEach((item) => walk(item, visitor));
  }

  function renderCue(force) {
    if (!state.layer || !state.settings.enabled) return;
    const cue = getActiveCue();
    const fallbackText = cue ? "" : state.nativeText;
    const key = cue ? `${cue.start}:${cue.end}:${cue.text}` : `native:${fallbackText}`;
    if (!force && key === state.lastRenderedKey) return;
    state.lastRenderedKey = key;
    state.currentCue = cue || (fallbackText ? { id: "native", start: state.video?.currentTime || 0, end: (state.video?.currentTime || 0) + 2, text: fallbackText } : null);

    if (!state.currentCue?.text) {
      state.layer.dataset.empty = "true";
      state.layer.textContent = "";
      return;
    }

    state.layer.dataset.empty = "false";
    state.layer.textContent = "";
    const line = document.createElement("span");
    line.className = "npo-study-subtitle-line";
    line.addEventListener("mouseenter", (event) => maybePauseVideo(event));
    line.addEventListener("mouseleave", scheduleHidePopup);
    line.addEventListener("click", (event) => showExplanation(event, null));

    for (const token of tokenize(state.currentCue.text)) {
      const span = document.createElement("span");
      span.textContent = token.text;
      span.className = token.type === "word" ? "npo-study-word" : "npo-study-punctuation";
      if (token.type === "word") {
        span.addEventListener("mouseenter", (event) => showExplanation(event, token.text));
        span.addEventListener("mouseleave", () => {
          span.removeAttribute("data-active");
          scheduleHidePopup();
        });
      }
      line.appendChild(span);
      if (token.trailingSpace) line.appendChild(document.createTextNode(" "));
    }
    state.layer.appendChild(line);
  }

  function getActiveCue() {
    if (!state.video || !state.cues.length) return null;
    const time = state.video.currentTime || 0;
    while (state.currentIndex < state.cues.length - 1 && state.cues[state.currentIndex].end < time) state.currentIndex++;
    while (state.currentIndex > 0 && state.cues[state.currentIndex].start > time) state.currentIndex--;
    const cue = state.cues[state.currentIndex];
    return cue && time >= cue.start && time <= cue.end ? cue : null;
  }

  async function showExplanation(event, targetWord) {
    event.stopPropagation();
    cancelHidePopup();
    const anchor = event.currentTarget;
    if (anchor.classList?.contains("npo-study-word")) anchor.dataset.active = "true";
    maybePauseVideo(event);
    const cue = state.currentCue;
    if (!cue) return;
    positionPopup(anchor);
    state.popup.innerHTML = `<div class="npo-study-popup-title">Loading...</div>`;
    state.popup.hidden = false;
    const index = state.cues.indexOf(cue);
    const payload = {
      targetWord,
      subtitle: cue.text,
      previous: state.cues.slice(Math.max(0, index - 3), index).map((item) => item.text),
      next: state.cues.slice(index + 1, index + 4).map((item) => item.text),
      targetLanguage: state.settings.targetLanguage,
      explanationDepth: state.settings.explanationDepth
    };
    const explanation = await send({ type: "EXPLAIN_TEXT", payload }).catch((error) => ({
      translation: "",
      note: String(error),
      words: [],
      grammar: "",
      examples: []
    }));
    renderPopup(targetWord || "Subtitle", explanation, targetWord, cue);
    positionPopup(anchor);
  }

  function renderPopup(title, explanation, pronounceWord, cue) {
    const examples = (explanation.examples || []).filter((ex) => ex && (ex.nl || ex.target)).map((ex) => `<li>${escapeHtml(ex.nl || "")}${ex.target ? ` - ${escapeHtml(ex.target)}` : ""}</li>`).join("");
    const pronunciation = pronounceWord ? pronunciationControls() : "";
    state.popup.innerHTML = `
      <div class="npo-study-popup-title-row">
        <div class="npo-study-popup-title">${escapeHtml(title)}</div>
      </div>
      ${pronunciation}
      ${translationSection(explanation)}
      ${section("Note", explanation.note)}
      ${section("Grammar", explanation.grammar)}
      ${examples ? `<div class="npo-study-popup-section"><div class="npo-study-popup-label">Examples</div><ul class="npo-study-popup-list">${examples}</ul></div>` : ""}
    `;
    const pronounceButtons = state.popup.querySelectorAll(".npo-study-pronounce-button");
    for (const button of pronounceButtons) {
      button.addEventListener("click", async (event) => {
        event.stopPropagation();
        const mode = event.currentTarget.getAttribute("data-speak");
        const speed = Number(event.currentTarget.getAttribute("data-speed")) || 1;
        if (mode === "sentence") {
          await replayOriginalSentence(cue, speed, event.currentTarget);
        } else {
          await playPronunciation(pronounceWord, mode, speed, event.currentTarget);
        }
      });
    }
  }

  function pronunciationControls() {
    return `
      <div class="npo-study-pronounce-panel">
        <div class="npo-study-pronounce-row">
          <span>Word</span>
          ${pronunciationButton("word", 1, "1x")}
          ${pronunciationButton("word", 0.75, "0.75x")}
          ${pronunciationButton("word", 0.5, "0.5x")}
        </div>
        <div class="npo-study-pronounce-row">
          <span>Original</span>
          ${pronunciationButton("sentence", 1, "1x")}
          ${pronunciationButton("sentence", 0.75, "0.75x")}
          ${pronunciationButton("sentence", 0.5, "0.5x")}
        </div>
      </div>
    `;
  }

  function pronunciationButton(mode, speed, label) {
    const title = mode === "sentence" ? `Replay original sentence audio at ${label}` : `Play ${mode} pronunciation at ${label}`;
    return `<button class="npo-study-pronounce-button" data-speak="${mode}" data-speed="${speed}" type="button" title="${title}" aria-label="${title}">${label}</button>`;
  }

  function section(label, text) {
    return text ? `<div class="npo-study-popup-section"><div class="npo-study-popup-label">${label}</div><div class="npo-study-popup-text">${escapeHtml(text)}</div></div>` : "";
  }

  function translationSection(explanation) {
    const rows = [];
    if (explanation.translation) rows.push(`<div class="npo-study-popup-text">${escapeHtml(explanation.translation)}</div>`);
    if (explanation.sentence && explanation.sentence !== explanation.translation) {
      rows.push(`<div class="npo-study-popup-sublabel">Sentence</div><div class="npo-study-popup-text">${escapeHtml(explanation.sentence)}</div>`);
    }
    if (!rows.length) return "";
    return `<div class="npo-study-popup-section"><div class="npo-study-popup-label">Translation</div>${rows.join("")}</div>`;
  }

  function positionPopup(anchor) {
    const margin = 12;
    const gap = 12;
    const popupWidth = Math.min(360, window.innerWidth - margin * 2);
    state.popup.style.width = `${popupWidth}px`;
    state.popup.style.left = "0px";
    state.popup.style.top = "0px";

    const anchorRect = anchor?.getBoundingClientRect();
    const subtitleRect = state.layer?.getBoundingClientRect();
    const baseRect = anchorRect && anchorRect.width ? anchorRect : subtitleRect;
    const popupRect = state.popup.getBoundingClientRect();
    const centerX = baseRect ? baseRect.left + baseRect.width / 2 : window.innerWidth / 2;
    const left = Math.min(window.innerWidth - popupWidth - margin, Math.max(margin, centerX - popupWidth / 2));
    const aboveSubtitle = baseRect ? baseRect.top - popupRect.height - gap : margin;
    const top = Math.min(window.innerHeight - popupRect.height - margin, Math.max(margin, aboveSubtitle));

    state.popup.style.left = `${left}px`;
    state.popup.style.top = `${top}px`;
  }

  function hidePopup() {
    cancelHidePopup();
    if (state.popup) state.popup.hidden = true;
    maybeResumeVideo();
  }

  async function playPronunciation(text, mode, speed, button) {
    const cleanText = cleanPronunciationText(text);
    if (!cleanText) return;
    if (state.sentenceReplayCancel) state.sentenceReplayCancel();
    const requestId = ++state.pronunciationRequestId;
    const originalText = button ? button.textContent : "";
    if (button) {
      button.dataset.requestId = String(requestId);
      button.disabled = true;
      button.textContent = "...";
    }
    try {
      const response = await send({
        type: "GENERATE_SPEECH",
        payload: { text: cleanText, mode, speed }
      });
      if (!response?.ok || !response.audioDataUrl) throw new Error(response?.error || "OpenAI TTS failed.");
      if (requestId !== state.pronunciationRequestId) return;
      await playAudioDataUrl(response.audioDataUrl);
    } catch (error) {
      if (requestId !== state.pronunciationRequestId) return;
      setStatus(`${String(error && error.message ? error.message : error)} Falling back to browser voice.`);
      speakDutchFallback(cleanText, mode, speed);
    } finally {
      if (button && button.dataset.requestId === String(requestId)) {
        button.disabled = false;
        button.textContent = originalText;
        delete button.dataset.requestId;
      }
    }
  }

  async function replayOriginalSentence(cue, speed, button) {
    if (!state.video || !cue || !Number.isFinite(cue.start) || !Number.isFinite(cue.end) || cue.end <= cue.start) return;
    stopGeneratedPronunciation();
    if (state.sentenceReplayCancel) state.sentenceReplayCancel();
    const requestId = ++state.pronunciationRequestId;

    const originalText = button ? button.textContent : "";
    if (button) {
      button.dataset.requestId = String(requestId);
      button.disabled = true;
      button.textContent = "...";
    }

    const video = state.video;
    const restore = {
      time: video.currentTime,
      paused: video.paused,
      rate: video.playbackRate
    };
    let restored = false;
    const restoreOnce = () => {
      if (restored) return;
      restored = true;
      restoreVideoState(video, restore, true);
    };
    state.sentenceReplayCancel = () => {
      ++state.pronunciationRequestId;
      restoreOnce();
      video.dispatchEvent(new Event("timeupdate"));
      state.sentenceReplayCancel = null;
    };

    try {
      video.pause();
      video.playbackRate = speed;
      video.currentTime = Math.max(0, cue.start);
      await playVideoSegment(video, cue.end, requestId);
    } catch (error) {
      if (requestId === state.pronunciationRequestId) setStatus(`Could not replay original audio: ${String(error && error.message ? error.message : error)}`);
    } finally {
      if (requestId === state.pronunciationRequestId) {
        restoreOnce();
        state.sentenceReplayCancel = null;
      }
      if (button && button.dataset.requestId === String(requestId)) {
        button.disabled = false;
        button.textContent = originalText;
        delete button.dataset.requestId;
      }
    }
  }

  function playVideoSegment(video, endTime, requestId) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let timeoutId = null;
      const maxMs = Math.max(1500, ((endTime - video.currentTime) / Math.max(0.25, video.playbackRate)) * 1000 + 1200);
      const cleanup = () => {
        video.removeEventListener("timeupdate", onTimeUpdate);
        video.removeEventListener("ended", onEnded);
        video.removeEventListener("error", onError);
        clearTimeout(timeoutId);
      };
      const finish = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      };
      const onTimeUpdate = () => {
        if (requestId !== state.pronunciationRequestId || video.currentTime >= endTime) finish();
      };
      const onEnded = finish;
      const onError = () => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new Error("Video playback failed."));
      };

      video.addEventListener("timeupdate", onTimeUpdate);
      video.addEventListener("ended", onEnded);
      video.addEventListener("error", onError);
      timeoutId = setTimeout(finish, maxMs);
      video.play().then(() => {
        if (video.currentTime >= endTime) finish();
      }).catch((error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      });
    });
  }

  function restoreVideoState(video, restore, forcePaused) {
    video.pause();
    video.playbackRate = restore.rate;
    video.currentTime = restore.time;
    state.pausedByExtension = false;
    if (!forcePaused && !restore.paused) video.play().catch(() => {});
  }

  function isThumbnailSubtitleUrl(url) {
    return /\/thumbnails?\//i.test(String(url || ""));
  }

  function looksLikeSubtitleCueSet(cues) {
    const sample = cues.slice(0, 20).map((cue) => cue.text || "").join(" ");
    if (/\.(jpg|jpeg|png|webp)(?:\?|$)|thumbnail|sprite|#xywh=/i.test(sample)) return false;
    const letterMatches = sample.match(/\p{L}/gu) || [];
    return letterMatches.length >= 12;
  }

  async function playAudioDataUrl(audioDataUrl) {
    stopGeneratedPronunciation();
    const audio = new Audio(audioDataUrl);
    state.currentPronunciationAudio = audio;
    await audio.play();
  }

  function stopGeneratedPronunciation() {
    if (state.currentPronunciationAudio) {
      state.currentPronunciationAudio.pause();
      state.currentPronunciationAudio = null;
    }
    if ("speechSynthesis" in window) window.speechSynthesis.cancel();
  }

  function speakDutchFallback(text, mode, speed) {
    if (!("speechSynthesis" in window) || !("SpeechSynthesisUtterance" in window)) return;
    selectDutchVoice();
    if (!state.dutchVoice) {
      setStatus("No Dutch system voice found. Install a Dutch voice for better pronunciation.");
    }
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(cleanPronunciationText(text));
    utterance.lang = "nl-NL";
    if (state.dutchVoice) utterance.voice = state.dutchVoice;
    utterance.rate = Number.isFinite(speed) ? speed : (mode === "sentence" ? 0.82 : 0.74);
    utterance.pitch = 1;
    window.speechSynthesis.speak(utterance);
  }

  function cleanPronunciationText(text) {
    return String(text || "").replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
  }

  function scheduleHidePopup() {
    cancelHidePopup();
    state.hidePopupTimer = setTimeout(() => {
      if (!state.pointerOverPopup) hidePopup();
    }, 180);
  }

  function cancelHidePopup() {
    if (!state.hidePopupTimer) return;
    clearTimeout(state.hidePopupTimer);
    state.hidePopupTimer = null;
  }

  function maybePauseVideo() {
    if (!state.settings.pauseOnHover || !state.video || state.video.paused) return;
    state.video.pause();
    state.pausedByExtension = true;
  }

  function maybeResumeVideo() {
    if (!state.settings.resumeAfterHover || !state.pausedByExtension || !state.video) return;
    state.video.play().catch(() => {});
    state.pausedByExtension = false;
  }

  function observeNativeSubtitles() {
    const overlay = document.querySelector(".bmpui-ui-subtitle-overlay");
    if (!overlay) return;
    const update = () => {
      const text = (overlay.textContent || "").replace(/\s+/g, " ").trim();
      if (text && text !== state.nativeText) {
        state.nativeText = text;
        renderCue(true);
      }
    };
    new MutationObserver(update).observe(overlay, { childList: true, subtree: true, characterData: true });
    update();
  }

  function setStatus(text) {
    const status = state.toolbar?.querySelector(".npo-study-status");
    if (!status) return;
    status.textContent = text;
    status.hidden = false;
    clearTimeout(setStatus.timeout);
    setStatus.timeout = setTimeout(() => { status.hidden = true; }, 4500);
  }

  function parseVtt(text, url) {
    const lines = text.replace(/\r/g, "").split("\n");
    const cues = [];
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].includes("-->")) continue;
      const [rawStart, rawEnd] = lines[i].split("-->");
      const start = seconds(rawStart.trim());
      const end = seconds(rawEnd.trim().split(/\s+/)[0]);
      const cueLines = [];
      i++;
      while (i < lines.length && lines[i].trim()) cueLines.push(lines[i++]);
      const cueText = stripTags(cueLines.join(" ").trim());
      if (cueText && Number.isFinite(start) && Number.isFinite(end)) cues.push({ id: `${url}:${cues.length}`, start, end, text: cueText });
    }
    return cues;
  }

  function parseSrt(text, url) {
    const blocks = text.replace(/\r/g, "").split(/\n\s*\n/);
    const cues = [];
    for (const block of blocks) {
      const lines = block.split("\n").filter(Boolean);
      const timingIndex = lines.findIndex((line) => line.includes("-->"));
      if (timingIndex < 0) continue;
      const [rawStart, rawEnd] = lines[timingIndex].split("-->");
      const start = seconds(rawStart.trim().replace(",", "."));
      const end = seconds(rawEnd.trim().split(/\s+/)[0].replace(",", "."));
      const cueText = stripTags(lines.slice(timingIndex + 1).join(" "));
      if (cueText && Number.isFinite(start) && Number.isFinite(end)) cues.push({ id: `${url}:${cues.length}`, start, end, text: cueText });
    }
    return cues;
  }

  function parseTtml(text, url) {
    const doc = new DOMParser().parseFromString(text, "text/xml");
    return [...doc.querySelectorAll("p[begin][end], p[begin][dur]")].map((p, index) => {
      const start = seconds(p.getAttribute("begin"));
      const end = p.hasAttribute("end") ? seconds(p.getAttribute("end")) : start + seconds(p.getAttribute("dur"));
      return { id: `${url}:${index}`, start, end, text: stripTags(p.textContent || "") };
    }).filter((cue) => cue.text && Number.isFinite(cue.start) && Number.isFinite(cue.end));
  }

  function seconds(value) {
    if (typeof value === "number") return value;
    const text = String(value || "").trim();
    if (!text) return NaN;
    if (/^\d+(\.\d+)?s$/.test(text)) return parseFloat(text);
    const parts = text.replace(",", ".").split(":").map(Number);
    if (parts.some(Number.isNaN)) return Number(text);
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    return parts[0];
  }

  function tokenize(text) {
    const matches = String(text).matchAll(/([\p{L}\p{M}\p{N}'’.-]+|[^\s])(\s*)/gu);
    return [...matches].map((match) => ({
      text: match[1],
      trailingSpace: !!match[2],
      type: /[\p{L}\p{N}]/u.test(match[1]) ? "word" : "punct"
    }));
  }

  function stripTags(text) {
    return String(text || "").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
  }

  function escapeHtml(value) {
    return String(value || "").replace(/[&<>"']/g, (char) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      "\"": "&quot;",
      "'": "&#39;"
    })[char]);
  }

  function send(message) {
    return new Promise((resolve, reject) => {
      if (state.invalidated || !chrome.runtime?.id) {
        handleContextInvalidated();
        reject(new Error("Extension context invalidated."));
        return;
      }
      try {
        chrome.runtime.sendMessage(message, (response) => {
          const error = chrome.runtime.lastError;
          if (error) {
            if (isContextInvalidated(error.message)) handleContextInvalidated();
            reject(new Error(error.message));
            return;
          }
          resolve(response);
        });
      } catch (error) {
        if (isContextInvalidated(error && error.message)) handleContextInvalidated();
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  function isContextInvalidated(message) {
    return /context invalidated|receiving end does not exist|message port closed/i.test(String(message || ""));
  }

  function handleContextInvalidated() {
    if (state.invalidated) return;
    state.invalidated = true;
    if (state.discoverInterval) clearInterval(state.discoverInterval);
    state.discoverInterval = null;
    cancelHidePopup();
  }
})();
