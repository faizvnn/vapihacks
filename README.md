# Jamie — Live Podcast Fact Checker: Build Plan

## Part 2 implementation snapshot

Part 2 is implemented as a TypeScript pipeline with Jev/Exa adapters, bounded concurrency,
cancellation, deduplication, a correction policy, `POST /debug/sentence`, and WS `/live`.
Part 1's audio loop and Part 3's dashboard are not implemented in this branch.

Requires Node 22+ and npm. Put `TYPESAFE_API_KEY` and `EXA_API_KEY` in local `.env`
(see `.env.example`; `.env` is ignored by Git).

```powershell
npm install
npm run typecheck
npm test
npm run build
npm run fixtures
npm run dev
```

The server listens on `http://127.0.0.1:3000` by default. To submit a sentence from another terminal:

```powershell
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:3000/debug/sentence -ContentType 'application/json' -Body '{"text":"Paris is the capital of Germany."}'
```

Consume events at `ws://127.0.0.1:3000/live`. `/health` is liveness; `/ready` reports
provider warm-up status. Real speech requires injecting Part 1's `say(text)` into
`createApp` in `server/src/app.ts`; the standalone server never pretends to have spoken.
Use its `pipeline.onSentence` facade for transcripts and `resetSession()` before each new call.

Verification at this snapshot: typecheck/build pass, 22 pipeline tests pass, and all 30
synthetic fixture expectations pass. Mock fixtures verify orchestration, not model accuracy.
`npm run fixtures` writes a synthetic replay to `fixtures/events.json` for Part 3.
Local reports go to ignored `outputs/`.

Live spike: Exa authenticated and returned a highlight (first search approximately 1.4 s).
Jev gate and verdict both returned HTTP 403; live accuracy, threshold tuning, and the
sub-second latency target remain unverified. Server/WebSocket and adapter integration
tests are still pending. Run `npm run spike` to recheck provider access, or
`npm run fixtures -- --live --demo` for the three initial demo fixtures once access works.
The runner uses a mock speaker in both modes and never dispatches real audio.

---

A silent voice agent sits in on a live conversation. Every finished sentence is gated by
Jev ("is this a checkable claim?"), checked against Exa, and judged by Jev again. Confirmed
claims flash a green citation card; contradicted claims flash red **and Jamie speaks up**.

Runtime sponsors: Vapi, Deepgram (inside Vapi), TypeSafe Jev, Exa. Out: Manus, AdaL.

```
mic -> Vapi (Deepgram Nova-3) -> final transcript webhook -> sentence
     -> Jev noul gate -> Exa search -> Jev choice verdict
     -> dashboard card (always)  +  Vapi `say` (only if CONTRADICTED)
```

---

## 0. Corrections to the original brief (checked against docs, 2026-11-09)

| Brief said | What the docs say | What we do |
|---|---|---|
| POST `say` with a message | The `say` field is **`content`**, not `message`. Body: `{"type":"say","content":"...","interruptAssistantEnabled":true}` | Send `content`. |
| Assistant "muted on start" | Vapi has no listen-only mode. A normal assistant answers every turn. | Point the assistant's model at **our own `custom-llm` endpoint that returns an empty reply**. All speech goes through `say`. |
| Read `controlUrl` from the call | Documented for phone calls (`call.monitor.controlUrl` on the first `status-update: in-progress` webhook, or `GET /call/:id`). **Not confirmed for web calls.** | Part 1's first spike. Fallback chain in Part 1. |
| Jev threshold `0.85` for everything | A noul returns one probability. A choice returns a label, per-option probabilities and a separate `confidence`. Thresholds do not carry over between the two. | Tune each on fixtures. 0.85 is only a starting guess. |
| Exa "lite ~450ms" | `type: "lite"` exists (low latency, served from index, limited params). No latency number in the docs. | Measure it. Return `UNCLEAR` on missing highlights; evaluate `auto` separately after integration. |
| Jev never gets it wrong | Vendor's own benchmark is about 68% accuracy; latency claim is 70–500 ms. | Voice interrupt only on a confident CONTRADICTED. Everything else is a card. |

Jev facts we rely on: model `jev-1.13.0`, key in `TYPESAFE_API_KEY`, several questions per
request, 80 req/s limit. Python SDK is confirmed (`pip install typesafe-sdk`,
`client.system_one(state=..., questions={...})`, answer at `response.answers[name].noul`).
The official JavaScript SDK is [`@typesafe-ai/sdk`](https://github.com/typesafe-ai/typesafe-sdk-js/blob/main/README.md)
and requires Node 22+. Its `systemOne` method supports the gate and choice verdict in TypeScript.

---

## 1. Shared contract (agree in the first 15 minutes, then split)

Stack: Node 22+ with TypeScript, Fastify, `ws`, Vite + React, ngrok. One server process, in-memory
state, no database. The official Jev JS SDK is `@typesafe-ai/sdk` and requires Node 22+;
see the [Part 2 architecture](docs/part-2-architecture.md) for verified sources and integration decisions.

```
server/src/
  index.ts        boot, routes, WS /live                      (shared)
  types.ts        the types below                             (shared, frozen after kickoff)
  bus.ts          event emitter -> WS fan-out                 (shared)
  vapi.ts         webhook, silent LLM, controlUrl, say()      (Part 1)
  pipeline.ts     gate -> search -> verdict -> decide         (Part 2)
  jev.ts, exa.ts                                              (Part 2)
web/src/          producer screen                             (Part 3)
fixtures/
  sentences.json  ~30 labelled sentences (claim / banter, true / false)
  events.json     a recorded event stream for UI work
```

```ts
// Part 1 -> Part 2
type Sentence = { id: string; text: string; context: string[]; t: number }; // context = previous 2 sentences
pipeline.onSentence(s: Sentence): Promise<void>

// Part 2 -> Part 1
say(text: string): Promise<void>

// Server -> dashboard, over WS /live
type Event =
  | { type: "transcript"; id: string; text: string; final: boolean }
  | { type: "gate";       id: string; p: number; passed: boolean; ms: number }
  | { type: "evidence";   id: string; url: string; title: string; highlight: string; ms: number }
  | { type: "verdict";    id: string; verdict: "CONFIRMED" | "CONTRADICTED" | "UNCLEAR";
                          confidence: number; spoken: boolean; totalMs: number }
  | { type: "jamie";      text: string; status: "speaking" | "done" };
```

Each part works against a mock until integration:
- Part 1 calls a stub pipeline that says "claim detected" for any sentence with a number in it.
- Part 2 is driven by `POST /debug/sentence {text}` and `npm run fixtures`. No audio needed.
- Part 3 replays `fixtures/events.json` through the same WS.

`POST /debug/sentence` stays in the final build. It is the stage fallback if audio fails.

---

## 2. Part 1 — Voice loop (Vapi + Deepgram)

**Owner delivers:** sentences going into the pipeline, and a working `say()`.

1. **Web call.** `@vapi-ai/web`, `vapi.start(assistant)` with a transient assistant:
   - `transcriber: { provider: "deepgram", model: "nova-3", language: "en" }`
   - `voice: { provider: "deepgram", model: "aura-2", voiceId: ... }` (confirm the id in Vapi's voice library)
   - `model: { provider: "custom-llm", url: PUBLIC_URL + "/silent" , model: "silent" }`
   - no `firstMessage`; `firstMessageMode: "assistant-waits-for-user"`
   - `server: { url: PUBLIC_URL + "/vapi/webhook" }`,
     `serverMessages: ['transcript[transcriptType="final"]', "status-update", "speech-update"]`
   - raise `silenceTimeoutSeconds` and `maxDurationSeconds`, and turn off idle messages, so Vapi
     does not hang up or nag during a long monologue.
2. **Silent LLM.** `POST /silent/chat/completions` returns an OpenAI-shaped completion with empty
   content (handle `stream: true` with an immediate `[DONE]`).
3. **Webhook to sentences.** Keep `role: "user"` finals only. Split on sentence punctuation, buffer
   fragments shorter than about 5 words into the next one, attach the previous 2 sentences as
   `context`, emit `transcript`, call `pipeline.onSentence`.
4. **`controlUrl`.** Try in order, stop at the first that works:
   (a) `message.call.monitor.controlUrl` on the `status-update: in-progress` webhook,
   (b) `GET https://api.vapi.ai/call/:id` with the private key,
   (c) read it client-side from what `vapi.start()` resolves to and POST it to the server,
   (d) last resort: the browser speaks via the Web SDK when it receives a `jamie` event.
5. **`say(text)`.** POST `{"type":"say","content":text,"interruptAssistantEnabled":true}`. Emit
   `jamie` events around it.
6. **Echo guard.** Drop user transcripts between `speech-update` assistant `started` and `stopped`
   plus 500 ms, so Jamie does not fact-check itself through the speakers.

**Spikes, in this order (first 30 min):** does `say` produce audio while the model is the silent
endpoint; where `controlUrl` shows up on a web call; how long after the speaker stops the final
transcript arrives (tune Deepgram `endpointing` if it is slow).

**Done when:** talking into the mic prints sentences in the server log within about 500 ms of
finishing them, Jamie never talks unprompted, and `curl -X POST /debug/say` makes Jamie speak.

---

## 3. Part 2 — Fact-check brain (Jev + Exa)

**Owner delivers:** `pipeline.onSentence`, tuned on fixtures, with latency logged per stage.

Implementation design: [Part 2 architecture](docs/part-2-architecture.md), including module
boundaries, cancellation, evidence attribution, speech policy, and fixture acceptance criteria.

1. **Gate (`jev.ts`).** One request, state = `{ sentence, context }`, one noul `is_claim`:
   "The speaker states a specific factual or statistical claim that could be verified against a
   public source." Add criteria for the false cases: opinions, predictions, personal anecdotes,
   questions, jokes. Emit `gate`. Stop if below threshold.
2. **Search (`exa.ts`).** `POST https://api.exa.ai/search`, header `x-api-key`:
   `{ "query": <sentence + context if the sentence has a pronoun subject>, "type": "lite",
   "numResults": 3, "contents": { "highlights": true } }`.
   Take the top result's first highlight, title and URL. Emit `evidence`. 900 ms timeout; on
   timeout or no highlights, emit `UNCLEAR` and stop.
3. **Verdict (`jev.ts`).** State = `{ claim, evidence: [highlights] }`, one choice with options
   `CONFIRMED` (evidence states the same fact), `CONTRADICTED` (evidence states a different
   number, date or fact for the same thing), `UNCLEAR` (evidence is about something else or does
   not settle it). Emit `verdict`.
4. **Decide.** Speak only if `CONTRADICTED` and confidence is over the threshold. Line template:
   `"Quick correction. According to <domain>, <first sentence of highlight, max 25 words>."`
5. **Guardrails.** One voice interrupt per 10 s; skip claims already checked (normalised text);
   at most 3 sentences in flight, drop the oldest; never throw into the webhook handler.
6. **Tuning.** `npm run fixtures` runs all of `fixtures/sentences.json` and prints a table of
   gate probability, verdict, confidence and per-stage ms. Pick the two thresholds from that table.
   Pre-warm Jev and Exa with one dummy call at boot.

**Spikes (first 30 min):** one noul through the JS SDK (else switch to Python now); one Exa `lite`
call returning highlights; real latency for both.

**Done when:** the fixture run gets the demo sentences right, banter is ignored, and gate + search
+ verdict totals under about 1 s at p50.

**Stretch, only after integration:** a small LLM call to rewrite the sentence into a standalone
claim before search, and to phrase Jamie's line. Better quality, roughly +400 ms.

---

## 4. Part 3 — Producer screen + demo

**Owner delivers:** the projector view, the demo script, and the safety nets.

1. **Layout (one screen, readable from the back of the room).**
   - Left: rolling transcript. The sentence being checked is highlighted; ignored banter is dimmed.
   - Centre: Jev gate meter for the latest sentence with the threshold line drawn on it.
   - Right: citation cards, newest on top. Green CONFIRMED, red CONTRADICTED, grey UNCLEAR. Each
     has the claim, the highlight, the source domain as a link, and total ms.
   - Top bar: call status, "Jamie speaking" indicator, running counts, p50 latency.
   - Small footer strip naming the four stages with their live ms. This answers "why did you use X?"
2. **Wiring.** One WS hook reducing `Event`s into state, keyed by sentence `id`. Start/Stop call
   buttons (the Vapi client wrapper comes from Part 1). A hidden text box that posts to
   `/debug/sentence`.
3. **Build order.** Static layout against `fixtures/events.json` first, then live WS, then
   animation and polish. Use AdaL here if the credits are useful; it stays out of the runtime.
4. **Demo script (90 s).** Four beats, every line pre-tested against Exa that day:
   banter (nothing fires, meter stays low) → a true stat (green card) → a well-known false claim
   (red card, Jamie interrupts with a source) → a claim about something recent (shows it is live
   web, not model memory).
5. **Safety nets.** Screen recording of one clean run; the `/debug/sentence` box; wired mic and
   headphones or low speaker volume; test on the venue network.

**Done when:** a judge who has heard nothing about the project can follow what happened from the
screen alone.

---

## 5. Timeline (about 3 hours)

| Time | Part 1 — Voice | Part 2 — Brain | Part 3 — Screen |
|---|---|---|---|
| 0:00–0:15 | Together: repo, keys in `.env`, ngrok, freeze `types.ts`, write 10 fixture sentences | | |
| 0:15–0:45 | Spikes: silent LLM + `say`, `controlUrl` | Spikes: Jev noul, Exa lite | Static layout on mock events |
| 0:45–1:30 | Webhook → sentences, echo guard | Full pipeline + fixture runner | Live WS, cards, meter |
| 1:30–2:00 | **Integrate:** real audio → pipeline → cards → voice. All three at one laptop. | | |
| 2:00–2:40 | Endpointing and interrupt feel | Threshold tuning on real speech | Polish, latency strip |
| 2:40–3:00 | Rehearse three times, record the backup run, freeze the code | | |

Cut order if behind: stretch LLM rewrite → UNCLEAR cards → gate meter animation. Never cut the
voice interrupt; it is the demo.

## 6. Open risks

- **`controlUrl` on web calls** is the one unverified link the whole voice interrupt hangs on.
  If options (a)–(c) all fail, (d) still gets Jamie speaking.
- **Sentences without context** ("and it tripled last year") search badly. Context is passed to
  Jev and Exa, but the demo script should use self-contained claims.
- **Jev verdict quality** on messy highlights is unknown until the fixture run. If it is poor,
  swap the verdict step for an LLM behind the same function and keep Jev as the gate.
- **One mic, no speaker labels.** Vapi sees every human voice as "user". Fine for the demo.
