# DutchMate

DutchMate is a Dutch study tool for NPO Start videos.

## Structure

- `extension/`: Manifest V3 Chrome extension that renders interactive subtitles, word tooltips, word pronunciation, and original-audio sentence replay.
- `server/`: FastAPI server that calls OpenAI for subtitle translation/explanation and caches successful responses in memory.

## Local Development

Run the server:

```bash
cd server
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
uvicorn app.main:app --host 127.0.0.1 --port 8787 --reload
```

Load the extension:

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Click **Load unpacked**.
4. Select `/Users/wei.zhou/Documents/NpoDutchExt/extension`.

See `extension/README.md` and `server/README.md` for details.
