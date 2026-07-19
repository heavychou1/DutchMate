# DutchMate Chrome Extension

A Manifest V3 Chrome extension that adds an interactive Dutch-study subtitle layer to NPO Start videos.

## What it does

- Detects NPO/Bitmovin player pages under `https://npo.nl/start/afspelen/*`.
- Watches for subtitle resources loaded by the page.
- Parses VTT, SRT, TTML, and simple JSON cue arrays.
- Renders its own subtitle overlay with one hoverable `<span>` per word.
- Shows a translation/explanation popup on word hover or subtitle click.
- Can pause the video while hovering words.
- Includes local basic hints by default and optional OpenAI-powered explanations.
- Uses OpenAI TTS for word pronunciation when an API key is configured, with 1x, 0.75x, and 0.5x speeds.
- Replays sentence pronunciation from the original video audio, then returns to the saved paused timestamp.
- Can fetch tooltip explanations from the DutchMate FastAPI server, so users do not need their own OpenAI API key for translation/explanation.

## Load in Chrome

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Click **Load unpacked**.
4. Select this folder: `/Users/wei.zhou/Documents/NpoDutchExt/extension`.
5. Open an NPO Start player page.

## Notes

NPO uses Bitmovin Player and its native subtitle overlay has `pointer-events: none`, so the extension intentionally renders a separate study subtitle layer instead of trying to attach events to NPO's subtitle DOM.

The first version is endpoint-tolerant: it listens for subtitle-looking network responses and parses common subtitle formats. If NPO exposes subtitles through a specific API response you already found, add the URL/shape to `src/content.js` in `processBody` or `extractCueArrays`.

Word pronunciation requests are routed through the extension background worker. If no OpenAI API key is configured, word pronunciation falls back to the browser's installed Dutch voice.

## DutchMate Server

The optional server lives in `../server/`. It exposes `POST /api/explain`, calls OpenAI on cache misses, and caches successful explanations in memory.

Local development:

```bash
cd ../server
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
uvicorn app.main:app --host 127.0.0.1 --port 8787 --reload
```

Set `OPENAI_API_KEY` in `server/.env`. In the extension options, choose `DutchMate server` and use `http://127.0.0.1:8787` as the server URL.
