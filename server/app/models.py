from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field


class Example(BaseModel):
    nl: str = ""
    target: str = ""


class WordExplanation(BaseModel):
    dutch: str = ""
    translation: str = ""
    note: str = ""


class ExplainRequest(BaseModel):
    videoId: str = ""
    videoTitle: str = ""
    targetLanguage: str = "English"
    level: str = "simple"
    explanationDepth: str | None = None
    targetWord: str | None = None
    subtitle: str = Field(..., min_length=1, max_length=1200)
    previous: list[str] = Field(default_factory=list)
    next: list[str] = Field(default_factory=list)

    def normalized_level(self) -> str:
        return (self.explanationDepth or self.level or "simple").strip()[:40] or "simple"


class ExplainResponse(BaseModel):
    source: str
    translation: str = ""
    sentence: str = ""
    note: str = ""
    grammar: str = ""
    words: list[WordExplanation] = Field(default_factory=list)
    examples: list[Example] = Field(default_factory=list)
    model: str = ""
    promptVersion: str = ""
    cacheKey: str = ""


class HealthResponse(BaseModel):
    ok: bool
    cacheEntries: int
    model: str


def model_to_dict(model: BaseModel) -> dict[str, Any]:
    if hasattr(model, "model_dump"):
        return model.model_dump()
    return model.dict()
