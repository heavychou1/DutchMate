(function () {
  const SOURCE = "npo-dutch-study-page-hook";
  const REQUEST_SOURCE = "npo-dutch-study-content";
  const MAX_BODY_CHARS = 180000;
  const interestingUrl = /subtitle|ondertitel|caption|texttrack|ttml|webvtt|\.vtt(?:\?|$)|\.srt(?:\?|$)|stream-link|player-token|metadata|program|POW_|MID_/i;
  const queue = [];

  function post(payload) {
    const event = { source: SOURCE, ...payload };
    queue.push(event);
    if (queue.length > 120) queue.shift();
    window.postMessage(event, window.location.origin);
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.data?.source !== REQUEST_SOURCE) return;
    if (event.data.type === "replay") {
      for (const item of queue) window.postMessage({ ...item, replay: true }, window.location.origin);
    }
  });

  function maybePostUrl(url, via) {
    if (!url || typeof url !== "string") return;
    if (interestingUrl.test(url)) post({ type: "resource-url", url, via });
  }

  function maybePostBody(url, body, contentType, via) {
    if (!body || typeof body !== "string") return;
    if (!interestingUrl.test(url) && !/(WEBVTT|<tt|<ttml|begin=|subtitles?|ondertiteling|textTracks?)/i.test(body)) return;
    post({
      type: "resource-body",
      url,
      via,
      contentType: contentType || "",
      body: body.slice(0, MAX_BODY_CHARS)
    });
  }

  const originalFetch = window.fetch;
  if (typeof originalFetch === "function") {
    window.fetch = async function patchedFetch(input, init) {
      const response = await originalFetch.apply(this, arguments);
      const url = typeof input === "string" ? input : input && input.url;
      maybePostUrl(url || response.url, "fetch");
      try {
        const contentType = response.headers && response.headers.get("content-type");
        const finalUrl = response.url || url;
        if (interestingUrl.test(finalUrl || "") || /json|text|xml|vtt|ttml/i.test(contentType || "")) {
          response.clone().text().then((body) => maybePostBody(finalUrl, body, contentType, "fetch")).catch(() => {});
        }
      } catch (_) {}
      return response;
    };
  }

  const XHR = window.XMLHttpRequest;
  if (XHR && XHR.prototype) {
    const open = XHR.prototype.open;
    const send = XHR.prototype.send;
    XHR.prototype.open = function patchedOpen(method, url) {
      this.__npoStudyUrl = url;
      return open.apply(this, arguments);
    };
    XHR.prototype.send = function patchedSend() {
      this.addEventListener("load", () => {
        const url = this.responseURL || this.__npoStudyUrl;
        maybePostUrl(url, "xhr");
        try {
          if (typeof this.responseText === "string") {
            maybePostBody(url, this.responseText, this.getResponseHeader("content-type"), "xhr");
          }
        } catch (_) {}
      });
      return send.apply(this, arguments);
    };
  }
})();
