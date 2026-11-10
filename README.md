# Jamie — Live Podcast Fact Checker

Say a claim into the mic. The screen turns green if the web backs it up and red if it doesn't.
On red, Jamie says the correction out loud.

One-hour build, three people, two files.

## How it works

Vapi runs the mic call and transcribes with Deepgram. We register our own server as Vapi's LLM.
Each time the speaker pauses, Vapi sends us what they said. We check it and reply with either
nothing (Jamie stays silent) or one correction sentence (Vapi speaks it).

```
mic -> Vapi (Deepgram Nova-3) -> POST /chat/completions on our server
   1. Jev yes/no:  is this a checkable claim?        no -> reply ""   screen grey
   2. Exa search:  top highlight + URL
   3. Jev choice:  CONFIRMED / CONTRADICTED / UNCLEAR
        CONFIRMED    -> reply ""                     screen green
        CONTRADICTED -> reply one correction line    screen red, Jamie speaks (Deepgram Aura-2)
        UNCLEAR      -> reply ""                     screen grey
```

No webhooks, no `controlUrl`, no WebSocket, no database.

## Files

```
server.py    FastAPI: POST /chat/completions, GET /last, serves index.html
index.html   Start button, full-screen colour, the claim and its source in big text
.env         VAPI_PUBLIC_KEY, TYPESAFE_API_KEY, EXA_API_KEY
```

Python, because Jev's Python SDK is the one we know works (`pip install typesafe-sdk`).

## The one thing to agree on

```python
async def check(text: str) -> dict:
    # {"verdict": "CONFIRMED" | "CONTRADICTED" | "UNCLEAR" | "NOT_A_CLAIM",
    #  "claim": text, "say": "" or one sentence, "source": url or ""}
```

Person 2 writes it. Person 1 calls it. Person 3 displays what it returned.

## Who does what

### Person 1 — Vapi

- `ngrok http 8000`, and a Start button that calls `vapi.start(...)` from `@vapi-ai/web`:
  ```js
  {
    transcriber: { provider: "deepgram", model: "nova-3", language: "en" },
    voice: { provider: "deepgram", model: "aura-2", voiceId: "thalia" },   // confirm the voice id
    model: { provider: "custom-llm", url: "<ngrok url>", model: "jamie" },
    firstMessageMode: "assistant-waits-for-user",
  }
  ```
- `POST /chat/completions`: take the last `user` message, call `check()`, save the result for
  `/last`, and stream back `result["say"]` in OpenAI format:
  ```
  data: {"choices":[{"index":0,"delta":{"content":"<say>"}}]}
  data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}
  data: [DONE]
  ```
- Start with a stub `check()` that only speaks when the sentence contains "test".

### Person 2 — `check()`

- **Gate.** One Jev noul on the sentence: "The speaker states a specific factual or statistical
  claim that could be verified against a public source." Under 0.8, return `NOT_A_CLAIM`.
- **Search.** `POST https://api.exa.ai/search`, header `x-api-key`, body
  `{"query": text, "type": "lite", "numResults": 3, "contents": {"highlights": true}}`.
  Keep the first highlight and URL.
- **Verdict.** One Jev choice on `{claim, evidence}` with options CONFIRMED, CONTRADICTED, UNCLEAR.
- **Line.** On CONTRADICTED: `"Quick correction. According to <domain>, <first sentence of highlight>."`
- Build and test it from the command line with six sentences. No audio needed.

### Person 3 — Screen and demo

- `index.html`: poll `GET /last` every 300 ms. Grey when idle, green on CONFIRMED, red on
  CONTRADICTED. Show the claim and the source domain in large text. Fade back to grey after 5 s.
- Collect the three API keys into `.env`.
- Pick the three demo lines and test each one against Exa: some banter (stays grey), a true stat
  (green), a well-known false claim (red, Jamie speaks).
- Record one clean run as a backup.

## The hour

| Time | What |
| --- | --- |
| 0:00–0:05 | Agree on `check()`, share keys, start ngrok |
| 0:05–0:35 | Build the three pieces in parallel |
| 0:35–0:50 | Plug `check()` into the endpoint, run it with real audio |
| 0:50–1:00 | Rehearse the three demo lines, record the backup |

## Check in the first 10 minutes

- An empty reply from our endpoint keeps Jamie silent. (Person 1)
- One Jev noul call returns a probability. (Person 2)
- One Exa `lite` call returns highlights. If it doesn't, use `"type": "auto"`. (Person 2)

## If something doesn't cooperate

- **Custom LLM endpoint won't work:** read transcripts in the browser from the Web SDK `message`
  event, POST them to a `/check` route, and on red speak with the Web SDK's `say` (check its README
  for the exact call).
- **Jev's verdict is unreliable:** swap that one step for an LLM call. Keep Jev as the gate.
- **Audio fails on stage:** a text box that posts a sentence to `/check` still turns the screen
  green or red.
