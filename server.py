"""Person 1 owns this file.   Run:  uvicorn server:app --reload --port 8000

CONTRACTS (routes the other parts rely on):
  POST /chat/completions   Vapi -> us. Take the last user message, call check(), stream back result["say"].
  POST /check {"text"}     Same check without audio. Returns the CheckResult. For testing and as a fallback.
  GET  /last               The latest CheckResult plus "n", a counter that goes up by one per check.
  GET  /config             {"publicKey", "assistantId", "assistant"} for the Start button in index.html.
"""

import json
import os
import time
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, StreamingResponse

from check import check

load_dotenv()

app = FastAPI()
last_result = {"n": 0}


async def run_check(text: str) -> dict:
    global last_result
    t0 = time.time()
    result = await check(text)
    last_result = {**result, "n": last_result["n"] + 1}
    print(f"[check] {int((time.time() - t0) * 1000)}ms {result['verdict']}: {text!r} -> say={result['say']!r}")
    return last_result


def _text_of(content) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):  # OpenAI content parts
        return " ".join(p.get("text", "") for p in content if isinstance(p, dict))
    return ""


def _sse(say: str):
    base = {"id": f"jamie-{int(time.time() * 1000)}", "object": "chat.completion.chunk",
            "created": int(time.time()), "model": "jamie"}
    if say:
        yield f"data: {json.dumps({**base, 'choices': [{'index': 0, 'delta': {'role': 'assistant', 'content': say}, 'finish_reason': None}]})}\n\n"
    yield f"data: {json.dumps({**base, 'choices': [{'index': 0, 'delta': {}, 'finish_reason': 'stop'}]})}\n\n"
    yield "data: [DONE]\n\n"


@app.post("/chat/completions")
async def chat_completions(request: Request):
    body = await request.json()
    user_messages = [m for m in body.get("messages", []) if m.get("role") == "user"]
    text = _text_of(user_messages[-1].get("content")).strip() if user_messages else ""
    say = ""
    if text:
        try:
            say = (await run_check(text)).get("say", "")
        except Exception as e:  # never let Vapi see a 500
            print(f"[check] error: {e!r}")
    if body.get("stream"):
        return StreamingResponse(_sse(say), media_type="text/event-stream")
    return {"id": "jamie", "object": "chat.completion", "model": "jamie",
            "choices": [{"index": 0, "finish_reason": "stop",
                         "message": {"role": "assistant", "content": say}}]}


@app.post("/check")
async def check_route(request: Request):
    body = await request.json()
    return await run_check(body.get("text", ""))


@app.get("/last")
async def last():
    return last_result


def assistant_config() -> dict:
    # Inline custom-LLM web call works (tested 6:45pm), so a stored assistant is optional.
    public_url = os.getenv("PUBLIC_URL", "").rstrip("/")
    return {
        "name": "Jamie",
        "firstMessageMode": "assistant-waits-for-user",
        "transcriber": {"provider": "deepgram", "model": "nova-3", "language": "en"},
        "model": {"provider": "custom-llm", "url": public_url, "model": "jamie",
                  "messages": [{"role": "system", "content": "Fact checker."}]},
        "voice": {"provider": "deepgram", "voiceId": os.getenv("VOICE_ID", "asteria")},
        "silenceTimeoutSeconds": 600,
        "maxDurationSeconds": 1800,
        "messagePlan": {"idleMessages": []},
    }


@app.get("/config")
async def config():
    return {"publicKey": os.getenv("VAPI_PUBLIC_KEY", ""),
            "assistantId": os.getenv("VAPI_ASSISTANT_ID", ""),
            "assistant": assistant_config()}


@app.get("/")
async def index():
    return FileResponse(Path(__file__).parent / "index.html")
