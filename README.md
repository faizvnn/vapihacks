<div align="center">

# Jamie

**A live fact checker that sits in on your conversation.**

Say a claim out loud. Jamie checks it against the live web in about a second.<br>
True: the screen turns green. False: the screen turns red and Jamie corrects you with a source.

[![Watch the demo](docs/demo-poster.jpg)](docs/demo.mp4)

▶ [Watch the 28-second demo](docs/demo.mp4)

Built at the Side Quest Hotline Vapi Hackathon · Vapi HQ, San Francisco · Nov 2026

</div>

---

## Why

Normal voice agents are built for one person talking to one bot. Put one in a room with two people and it answers every pause, and each web lookup leaves three seconds of silence.

Jamie works differently. It is a **silent third participant**. It stays quiet during normal conversation, shows a source on screen when you say something true, and only speaks up when you say something false.

## Use cases

- **Podcasts and live streams:** live citations for the audience, without stopping the host
- **Debates and panels:** call out wrong numbers the moment they're said
- **Meetings and sales calls:** catch a wrong stat before it ends up in the deck
- **Classrooms and study groups:** quick, sourced corrections in plain speech

## How it works

```
mic ─▶ Vapi (Deepgram Nova-3 STT) ─▶ POST /chat/completions  (our server is Vapi's "LLM")
                                         │
                                         ├─ 1. Jev gate      is this a checkable factual claim?   no ─▶ stay silent
                                         ├─ 2. Exa search    top 3 live web results + highlights
                                         ├─ 3. Jev verdict   CONFIRMED / CONTRADICTED / UNCLEAR
                                         └─ 4. Jev pick      best evidence sentence to read out
                                         │
              screen ◀─ GET /last ───────┤   green · red · grey
              speaker ◀─ streamed reply ─┘   only on CONTRADICTED (Deepgram TTS)
```

- **No generative LLM anywhere in the loop.** Jev, a discriminative model from TypeSafe, decides whether something is a claim and judges it against the evidence, so there's no free-text generation and no hallucinated corrections.
- **Silent by default.** Our endpoint returns an empty completion unless the claim is contradicted, so Vapi only speaks when there's a correction to make.
- **The correction comes from the source.** Jamie reads the evidence sentence that best states the right fact: *"Quick correction. According to science.nasa.gov, …"*
- **Fails safe.** Any timeout or error resolves to `UNCLEAR` and never to "true." Thresholds: gate ≥ 0.7, verdict ≥ 0.8, spoken line ≥ 0.5.
- **Fast.** The Jev and Exa connections are warmed up at boot and reused. Exa runs in `fast` mode, about 350 ms.

## Stack

| Layer | Tech |
| --- | --- |
| Voice call, turn-taking | [Vapi](https://vapi.ai) web SDK, custom-LLM provider |
| Speech-to-text / TTS | [Deepgram](https://deepgram.com) Nova-3 / Aura |
| Claim gate + verdict | [TypeSafe Jev](https://typesafe.ai) (`noul` + `choice`) |
| Live web evidence | [Exa](https://exa.ai) search with highlights |
| Server | Python 3.10+, FastAPI, httpx |
| UI | Single `index.html`, polls `/last` |

## Run it

**Requirements:** Python 3.10+, plus API keys for Vapi (public), Exa, and TypeSafe.

```bash
pip install -r requirements.txt
cp .env.example .env               # add VAPI_PUBLIC_KEY, EXA_API_KEY, TYPESAFE_API_KEY
npx cloudflared tunnel --url http://localhost:8000   # copy the https URL into PUBLIC_URL
uvicorn server:app --port 8000
```

Open **http://localhost:8000**, click **Start**, allow the mic, and say something like *"The Eiffel Tower is 500 meters tall."*

You can also test without a mic:

```bash
python check.py "The Sun is a planet."
curl -X POST localhost:8000/check -H 'content-type: application/json' -d '{"text":"Water boils at 50 degrees Celsius."}'
```

## API

| Route | Purpose |
| --- | --- |
| `POST /chat/completions` | Vapi custom-LLM endpoint. Streams back the correction, or nothing |
| `POST /check` `{text}` | Run a check without audio. Returns `{verdict, claim, say, source}` |
| `GET /last` | Latest result plus a counter `n`. The UI polls this |
| `GET /config` | Vapi public key and inline assistant config for the Start button |

## Repo layout

```
server.py      FastAPI server: Vapi endpoint, /check, /last, /config
check.py       Fact-check pipeline: Jev gate → Exa → Jev verdict → correction line
index.html     Full-screen verdict UI + Vapi Start button
server/        TypeScript voice loop (ambient mode: webhooks, controlUrl barge-in, echo guard)
fixtures/      Labelled test sentences and recorded provider responses
docs/          Architecture, integration notes, demo video
```

## Team

Faizan Hussain · Jorge Meza · and team
