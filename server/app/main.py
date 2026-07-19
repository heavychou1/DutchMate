from __future__ import annotations

import hashlib
import json
import os
from dataclasses import dataclass

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware

from .cache import TTLCache
from .models import ExplainRequest, ExplainResponse, HealthResponse, model_to_dict
from .openai_client import OpenAIClientError, OpenAIExplainClient, PROMPT_VERSION
from .rate_limit import SlidingWindowRateLimiter

load_dotenv()


@dataclass(frozen=True)
class Settings:
    openai_api_key: str = os.getenv("OPENAI_API_KEY", "")
    openai_model: str = os.getenv("OPENAI_MODEL", "gpt-4.1-mini")
    cache_max_entries: int = int(os.getenv("DUTCHMATE_CACHE_MAX_ENTRIES", "20000"))
    cache_ttl_seconds: int = int(os.getenv("DUTCHMATE_CACHE_TTL_SECONDS", "604800"))
    rate_limit_per_minute: int = int(os.getenv("DUTCHMATE_RATE_LIMIT_PER_MINUTE", "120"))
    shared_secret: str = os.getenv("DUTCHMATE_SHARED_SECRET", "")
    allowed_origins: str = os.getenv("DUTCHMATE_ALLOWED_ORIGINS", "*")

    def cors_origins(self) -> list[str]:
        return [item.strip() for item in self.allowed_origins.split(",") if item.strip()] or ["*"]


settings = Settings()
cache = TTLCache(settings.cache_max_entries, settings.cache_ttl_seconds)
rate_limiter = SlidingWindowRateLimiter(settings.rate_limit_per_minute)
openai_client = OpenAIExplainClient(settings.openai_api_key, settings.openai_model)

app = FastAPI(title="DutchMate API", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins(),
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)


@app.get("/health", response_model=HealthResponse)
async def health() -> HealthResponse:
    return HealthResponse(ok=True, cacheEntries=len(cache), model=settings.openai_model)


@app.post("/api/explain", response_model=ExplainResponse)
async def explain(payload: ExplainRequest, request: Request) -> ExplainResponse:
    verify_secret(request)
    if not rate_limiter.allow(client_key(request)):
        raise HTTPException(status_code=429, detail="Rate limit exceeded.")

    key = cache_key(payload)
    cached = cache.get(key)
    if cached:
        cached["source"] = "cache"
        return ExplainResponse(**cached)

    try:
        response = await openai_client.explain(payload, key)
    except OpenAIClientError as error:
        raise HTTPException(status_code=502, detail=str(error)) from error

    cache.set(key, model_to_dict(response))
    return response


def verify_secret(request: Request) -> None:
    if not settings.shared_secret:
        return
    auth = request.headers.get("authorization", "")
    bearer = auth.removeprefix("Bearer ").strip() if auth.startswith("Bearer ") else ""
    token = request.headers.get("x-dutchmate-token", "") or bearer
    if token != settings.shared_secret:
        raise HTTPException(status_code=401, detail="Missing or invalid server token.")


def client_key(request: Request) -> str:
    forwarded = request.headers.get("x-forwarded-for", "").split(",")[0].strip()
    if forwarded:
        return forwarded
    return request.client.host if request.client else "unknown"


def cache_key(payload: ExplainRequest) -> str:
    material = {
        "promptVersion": PROMPT_VERSION,
        "model": settings.openai_model,
        "videoId": payload.videoId,
        "targetLanguage": payload.targetLanguage,
        "level": payload.normalized_level(),
        "targetWord": payload.targetWord or "",
        "subtitle": payload.subtitle,
        "previous": payload.previous[-3:],
        "next": payload.next[:3],
    }
    digest = hashlib.sha256(json.dumps(material, ensure_ascii=False, sort_keys=True).encode("utf-8")).hexdigest()
    return f"explain:{PROMPT_VERSION}:{digest}"
