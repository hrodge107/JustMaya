import asyncio
import json
import random
from dataclasses import dataclass, field
from typing import Any, Protocol

import httpx

from app.config import Settings


@dataclass
class GenerationResult:
    text: str
    usage: dict[str, int] = field(default_factory=dict)


@dataclass
class StructuredResult:
    data: dict[str, Any]
    usage: dict[str, int] = field(default_factory=dict)


class ModelProviderError(Exception):
    def __init__(self, code: str, message: str, retryable: bool = False):
        super().__init__(message)
        self.code = code
        self.message = message
        self.retryable = retryable


class GenerationProvider(Protocol):
    async def generate_text(
        self,
        *,
        system: str,
        user: str,
        max_tokens: int | None = None,
        cache_key: str | None = None,
    ) -> GenerationResult: ...

    async def generate_structured(
        self,
        *,
        system: str,
        user: str,
        schema: dict[str, Any],
        max_tokens: int | None = None,
        cache_key: str | None = None,
    ) -> StructuredResult: ...

    async def count_input_tokens(self, *, system: str, user: str) -> int: ...


_MAX_ATTEMPTS = 3
_FORBIDDEN_SCHEMA_KEYS = {"$ref", "$defs", "$recursiveRef", "$dynamicRef", "definitions"}
_JSON_TYPES = {
    "object": dict, "array": list, "string": str,
    "number": (int, float), "integer": int, "boolean": bool, "null": type(None),
}


def _has_recursion(schema: Any) -> bool:
    if isinstance(schema, dict):
        return bool(_FORBIDDEN_SCHEMA_KEYS & schema.keys()) or any(
            _has_recursion(v) for v in schema.values()
        )
    if isinstance(schema, list):
        return any(_has_recursion(v) for v in schema)
    return False


def _validate(data: Any, schema: dict[str, Any], path: str = "$") -> None:
    # ponytail: flat object/array validator — upgrade to jsonschema when schemas grow
    expected = schema.get("type")
    if expected:
        types = expected if isinstance(expected, list) else [expected]
        ok = any(
            isinstance(data, _JSON_TYPES[t])
            and not (t in ("number", "integer") and isinstance(data, bool))
            and not (t == "integer" and not isinstance(data, int))
            for t in types if t in _JSON_TYPES
        )
        if not ok:
            raise ModelProviderError(
                "SCHEMA_MISMATCH", f"{path}: expected {expected}, got {type(data).__name__}"
            )
    if "enum" in schema and data not in schema["enum"]:
        raise ModelProviderError("SCHEMA_MISMATCH", f"{path}: {data!r} not in enum")
    if isinstance(data, dict):
        for key in schema.get("required", []):
            if key not in data:
                raise ModelProviderError("SCHEMA_MISMATCH", f"{path}: missing required '{key}'")
        props = schema.get("properties", {})
        for key, sub in props.items():
            if key in data:
                _validate(data[key], sub, f"{path}.{key}")
    elif isinstance(data, list) and "items" in schema:
        for i, item in enumerate(data):
            _validate(item, schema["items"], f"{path}[{i}]")


def _strictify(schema: Any) -> Any:
    if isinstance(schema, dict):
        out = {k: _strictify(v) for k, v in schema.items()}
        if out.get("type") == "object" or "properties" in out:
            out.setdefault("additionalProperties", False)
            if "properties" in out:
                out["required"] = list(dict.fromkeys(out.get("required", []) + list(out["properties"])))
        return out
    if isinstance(schema, list):
        return [_strictify(v) for v in schema]
    return schema


class MetaProvider:
    def __init__(
        self,
        settings: Settings,
        transport: httpx.AsyncBaseTransport | None = None,
        max_attempts: int = _MAX_ATTEMPTS,
        timeout: float | None = None,
    ):
        base = settings.meta_base_url.rstrip("/")
        self._url = f"{base}/chat/completions"
        self._count_url = f"{base}/responses/input_tokens"
        self._key = settings.meta_api_key.get_secret_value()
        self._model = settings.meta_model
        self._transport = transport
        self._max_attempts = max_attempts
        self._timeout = timeout if timeout is not None else settings.model_request_timeout_seconds

    async def generate_text(
        self,
        *,
        system: str,
        user: str,
        max_tokens: int | None = None,
        cache_key: str | None = None,
    ) -> GenerationResult:
        payload = self._payload(system, user, max_tokens, cache_key)
        body = await self._request(self._url, payload)
        return GenerationResult(text=self._content(body), usage=body.get("usage", {}))

    async def generate_structured(
        self,
        *,
        system: str,
        user: str,
        schema: dict[str, Any],
        max_tokens: int | None = None,
        cache_key: str | None = None,
    ) -> StructuredResult:
        if _has_recursion(schema):
            raise ModelProviderError(
                "SCHEMA_UNSUPPORTED", "Recursive JSON schemas are not supported by the endpoint"
            )
        payload = self._payload(system, user, max_tokens, cache_key)
        payload["response_format"] = {
            "type": "json_schema",
            "json_schema": {"name": "response", "schema": _strictify(schema), "strict": True},
        }
        body = await self._request(self._url, payload)
        raw = self._content(body)
        try:
            data = json.loads(raw)
        except (json.JSONDecodeError, TypeError) as exc:
            raise ModelProviderError(
                "BAD_JSON", f"Model output is not valid JSON: {raw[:200]!r}"
            ) from exc
        _validate(data, schema)
        return StructuredResult(data=data, usage=body.get("usage", {}))

    async def count_input_tokens(self, *, system: str, user: str) -> int:
        """Server-side input-token count for a would-be request (no generation).

        Hits the Responses API's counting endpoint; its rendering of
        instructions+input may differ from chat-completions by a few tokens —
        budgets need magnitude, not exactness.
        """
        body = await self._request(
            self._count_url,
            {"model": self._model, "instructions": system, "input": user},
        )
        try:
            return int(body["input_tokens"])
        except (KeyError, TypeError, ValueError) as exc:
            raise ModelProviderError(
                "BAD_RESPONSE", f"Unexpected count response: {str(body)[:200]}"
            ) from exc

    def _payload(
        self, system: str, user: str, max_tokens: int | None, cache_key: str | None
    ) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "model": self._model,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
        }
        if max_tokens is not None:
            payload["max_tokens"] = max_tokens
        if cache_key is not None:
            payload["prompt_cache_key"] = cache_key
        return payload

    async def _request(self, url: str, payload: dict[str, Any]) -> dict[str, Any]:
        last: ModelProviderError | None = None
        for attempt in range(self._max_attempts):
            try:
                return await self._once(url, payload)
            except ModelProviderError as exc:
                if not exc.retryable:
                    raise
                last = exc
                if attempt < self._max_attempts - 1:
                    await asyncio.sleep(2 ** attempt + random.uniform(0, 0.5))
        raise last or ModelProviderError("INTERNAL", "No attempts made", retryable=True)

    async def _once(self, url: str, payload: dict[str, Any]) -> dict[str, Any]:
        async with httpx.AsyncClient(
            transport=self._transport, timeout=self._timeout
        ) as client:
            try:
                resp = await client.post(
                    url,
                    json=payload,
                    headers={"Authorization": f"Bearer {self._key}"},
                )
            except (httpx.TimeoutException, httpx.TransportError) as exc:
                raise ModelProviderError(
                    "UPSTREAM_TIMEOUT" if isinstance(exc, httpx.TimeoutException) else "UPSTREAM_CONN",
                    f"Upstream {type(exc).__name__}",
                    retryable=True,
                ) from exc
        status = resp.status_code
        if status == 429 or status >= 500:
            raise ModelProviderError(
                f"HTTP_{status}", f"Endpoint returned {status}", retryable=True
            )
        if status >= 400:
            raise ModelProviderError(
                f"HTTP_{status}", f"Endpoint returned {status}: {resp.text[:200]}"
            )
        try:
            return resp.json()
        except (json.JSONDecodeError, ValueError) as exc:
            raise ModelProviderError(
                "BAD_RESPONSE", f"Endpoint returned non-JSON body: {resp.text[:200]}"
            ) from exc

    @staticmethod
    def _content(body: dict[str, Any]) -> str:
        try:
            content = body["choices"][0]["message"]["content"]
        except (KeyError, IndexError, TypeError) as exc:
            raise ModelProviderError(
                "BAD_RESPONSE", f"Unexpected response shape: {str(body)[:200]}"
            ) from exc
        if not isinstance(content, str):
            # ponytail: reasoning model returns content=null when max_tokens is
            # consumed by reasoning_tokens — caller should raise the cap
            raise ModelProviderError(
                "BAD_RESPONSE",
                f"Empty model content (finish_reason={body.get('choices', [{}])[0].get('finish_reason')}, "
                f"reasoning_tokens={body.get('usage', {}).get('completion_tokens_details', {}).get('reasoning_tokens')})",
            )
        return content
