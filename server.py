"""Person 1 owns this file.   Run:  uvicorn server:app --reload --port 8000

CONTRACTS (routes the other parts rely on):
  POST /chat/completions   Vapi -> us. Take the last user message, call check(), reply with result["say"].
  POST /check {"text"}     Same check without audio. Returns the CheckResult. For testing and as a fallback.
  GET  /last               The latest CheckResult plus "n", a counter that goes up by one per check.
  GET  /config             {"publicKey", "assistantId"} for the Start button in index.html.
"""

import os
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI, Request
from fastapi.responses import FileResponse

from check import check

load_dotenv()

app = FastAPI()
last_result = {"n": 0}


async def run_check(text: str) -> dict:
    global last_result
    result = await check(text)
    last_result = {**result, "n": last_result["n"] + 1}
    return last_result


@app.post("/chat/completions")
async def chat_completions(request: Request):
    body = await request.json()
    user_messages = [m for m in body.get("messages", []) if m.get("role") == "user"]
    text = user_messages[-1]["content"] if user_messages else ""
    result = await run_check(text)
    # TODO(Person 1): Vapi sends "stream": true and expects an OpenAI-style streamed reply
    # (chat.completion.chunk events, then "data: [DONE]"). This plain JSON reply is a placeholder.
    return {"choices": [{"index": 0, "finish_reason": "stop",
                         "message": {"role": "assistant", "content": result["say"]}}]}


@app.post("/check")
async def check_route(request: Request):
    body = await request.json()
    return await run_check(body.get("text", ""))


@app.get("/last")
async def last():
    return last_result


@app.get("/config")
async def config():
    # TODO(Person 1): Vapi rejects a custom LLM URL on an inline web-call assistant (403).
    # Create a stored assistant (dashboard or API, see README) and put its id in .env.
    return {"publicKey": os.getenv("VAPI_PUBLIC_KEY", ""), "assistantId": os.getenv("VAPI_ASSISTANT_ID", "")}


@app.get("/")
async def index():
    return FileResponse(Path(__file__).parent / "index.html")
