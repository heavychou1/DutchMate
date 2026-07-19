from __future__ import annotations

import json
import re
from typing import Any

import httpx

from .models import Example, ExplainRequest, ExplainResponse, WordExplanation


PROMPT_VERSION = "explain-v1"


class OpenAIClientError(Exception):
    pass


class OpenAIExplainClient:
    def __init__(self, api_key: str, model: str, timeout_seconds: float = 30.0) -> None:
        self.api_key = api_key
        self.model = model
        self.timeout_seconds = timeout_seconds

    async def explain(self, request: ExplainRequest, cache_key: str) -> ExplainResponse:
        if not self.api_key:
            raise OpenAIClientError("OPENAI_API_KEY is not configured.")

        payload = {
            "model": self.model,
            "input": build_prompt(request),
            "text": {"format": {"type": "json_object"}},
        }
        async with httpx.AsyncClient(timeout=self.timeout_seconds) as client:
            response = await client.post(
                "https://api.openai.com/v1/responses",
                headers={
                    "authorization": f"Bearer {self.api_key}",
                    "content-type": "application/json",
                },
                json=payload,
            )

        if response.status_code >= 400:
            raise OpenAIClientError(extract_error_message(response))

        data = response.json()
        parsed = parse_json_output(extract_response_text(data))
        normalized = normalize_explanation(parsed)
        normalized.source = "openai"
        normalized.model = self.model
        normalized.promptVersion = PROMPT_VERSION
        normalized.cacheKey = cache_key
        return normalized


def build_prompt(request: ExplainRequest) -> str:
    target = f"Target word: {request.targetWord}" if request.targetWord else "Target: whole subtitle"
    previous = "\n".join(request.previous[-3:])
    next_lines = "\n".join(request.next[:3])
    target_language = request.targetLanguage.strip()[:40] or "English"
    level = request.normalized_level()
    return "\n".join(
        [
            "You are DutchMate, a concise Dutch tutor for video subtitles.",
            f"Explain in {target_language}.",
            f"Depth: {level}.",
            "Return compact JSON with exactly these keys:",
            f'- "translation": the meaning of the target in {target_language} (a string).',
            f'- "sentence": the FULL current subtitle translated into {target_language} (a string).',
            f'- "note": a short usage note in {target_language} (a string).',
            f'- "grammar": a short grammar explanation in {target_language} (a string).',
            f'- "words": array of {{ "dutch": Dutch word, "translation": {target_language} meaning, "note": optional {target_language} note }}.',
            f'- "examples": array of {{ "nl": an example sentence written in DUTCH, "target": that sentence translated into {target_language} }}.',
            'Every "nl" field and every "dutch" field must be in Dutch.',
            f'Only "translation", "note", "grammar", and "target" are in {target_language}.',
            "",
            target,
            f"Video title: {request.videoTitle}",
            f"Current subtitle: {request.subtitle}",
            f"Previous subtitles:\n{previous}",
            f"Next subtitles:\n{next_lines}",
        ]
    )


def extract_error_message(response: httpx.Response) -> str:
    try:
        data = response.json()
        error = data.get("error")
        if isinstance(error, dict) and error.get("message"):
            return str(error["message"])
    except Exception:
        pass
    return f"OpenAI request failed with HTTP {response.status_code}."


def extract_response_text(data: dict[str, Any]) -> str:
    if isinstance(data.get("output_text"), str):
        return data["output_text"]
    parts: list[str] = []
    for item in data.get("output") or []:
        for content in item.get("content") or []:
            if isinstance(content.get("text"), str):
                parts.append(content["text"])
    return "\n".join(parts)


def parse_json_output(text: str) -> dict[str, Any]:
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        match = re.search(r"\{.*\}", text, re.DOTALL)
        if not match:
            raise OpenAIClientError("OpenAI returned non-JSON output.")
        return json.loads(match.group(0))


def normalize_explanation(value: Any) -> ExplainResponse:
    data = value if isinstance(value, dict) else {}
    return ExplainResponse(
        source="openai",
        translation=to_text(data.get("translation")),
        sentence=to_text(data.get("sentence")),
        note=to_text(data.get("note")),
        grammar=to_text(data.get("grammar")),
        words=normalize_words(data.get("words")),
        examples=normalize_examples(data.get("examples")),
    )


def normalize_words(value: Any) -> list[WordExplanation]:
    if not isinstance(value, list):
        return []
    out: list[WordExplanation] = []
    for item in value[:8]:
        if isinstance(item, str):
            dutch, _, translation = item.partition(":")
            out.append(WordExplanation(dutch=dutch.strip(), translation=translation.strip()))
        elif isinstance(item, dict):
            out.append(
                WordExplanation(
                    dutch=to_text(item.get("dutch") or item.get("word") or item.get("nl")),
                    translation=to_text(item.get("translation") or item.get("meaning") or item.get("target")),
                    note=to_text(item.get("note") or item.get("notes")),
                )
            )
    return [item for item in out if item.dutch or item.translation]


def normalize_examples(value: Any) -> list[Example]:
    if not isinstance(value, list):
        return []
    out: list[Example] = []
    for item in value[:3]:
        if isinstance(item, str):
            out.append(Example(nl=item.strip()))
        elif isinstance(item, dict):
            out.append(
                Example(
                    nl=to_text(item.get("nl") or item.get("dutch") or item.get("source")),
                    target=to_text(item.get("target") or item.get("translation") or item.get("meaning")),
                )
            )
    return [item for item in out if item.nl or item.target]


def to_text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value.strip()
    if isinstance(value, (int, float, bool)):
        return str(value)
    if isinstance(value, list):
        return "; ".join(filter(None, (to_text(item) for item in value)))
    if isinstance(value, dict):
        for key in ("text", "value", "explanation"):
            if isinstance(value.get(key), str):
                return value[key].strip()
        return "; ".join(f"{key}: {to_text(item)}" for key, item in value.items() if to_text(item))
    return ""
