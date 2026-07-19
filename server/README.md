# DutchMate API Server

FastAPI server for cached Dutch subtitle explanations.

## Run Locally

```bash
cd server
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
```

Add your OpenAI API key to `.env`, then run:

```bash
uvicorn app.main:app --host 127.0.0.1 --port 8787 --reload
```

Health check:

```bash
curl http://127.0.0.1:8787/health
```

## API

`POST /api/explain`

```json
{
  "videoId": "nos-journaal-in-makkelijke-taal_500",
  "videoTitle": "NOS Journaal in Makkelijke Taal",
  "targetLanguage": "English",
  "level": "simple",
  "targetWord": "er",
  "subtitle": "Ik heb er geen zin in.",
  "previous": ["Wil je mee naar buiten?"],
  "next": ["Ik blijf liever thuis."]
}
```

The server caches successful explanations in memory. Cache entries are not shared across multiple server processes; use Redis later if you deploy multiple replicas.
