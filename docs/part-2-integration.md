# Part 2 integration and validation

Part 2 runs without a microphone or dashboard. Start from the repository root on Node 22+:

```powershell
npm ci
npm run dev
```

Add `TYPESAFE_API_KEY` and `EXA_API_KEY` to local `.env`. All server/fixture/spike/smoke commands load it before application modules. Local values override inherited environment variables. Keep `.env` outside Git; `.env.example` lists the supported settings.

After merging with Part 1, the default TypeScript port is 8787, `/test` serves the existing voice test page, and `server/src/index.ts` wires Vapi transcripts and speech to this pipeline. The loader also reads legacy `server/.env` first, then root `.env` takes precedence. The Python app/UI on port 8000 is preserved separately and still uses its own `check.py` scaffold. It does not call this TypeScript pipeline.

## Part 1 handoff

Compose the runtime in your server entrypoint:

```ts
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createJev } from "./jev.js";
import { createExa } from "./exa.js";
import { say } from "./vapi.js"; // supplied by Part 1

const config = loadConfig();
const runtime = createApp({
  config,
  jev: createJev(config),
  exa: createExa(config.exaApiKey),
  say,
});
await runtime.app.listen({ host: config.host, port: config.port });
await runtime.warmUp();

// On a new call: invalidate all previous-call work, then accept new transcripts.
runtime.resetSession();
// For each final sentence: publish transcript, then submit without delaying webhook acknowledgement.
runtime.bus.publish({ type: "transcript", id: sentence.id, text: sentence.text, final: true });
void runtime.pipeline.onSentence(sentence);
// At call end:
runtime.pipeline.close();
```

Register Part 1's webhook/silent-LLM routes before listening. Part 1 remains responsible for sentence splitting, the previous two sentences of context, echo suppression, and genuine `jamie` speech lifecycle events. `say` must reject on dispatch failure and resolve only when its control transport accepts the command. Part 2 also bounds waiting for dispatch; a timed-out unsettled speaker retains the single-flight lock to avoid issuing overlapping commands. `spoken: true` means dispatch accepted, not proof of audible playback.

`pipeline.onSentence` contains provider failures. A new sentence can cancel the oldest of three active checks, while a session change blocks all late events and corrections. Sentence IDs must be unique per call. Retried IDs are suppressed; failed semantic checks can be retried with fresh IDs. The debug route uses this same session and pipeline.

## Part 3 handoff

Connect to `ws://127.0.0.1:8787/live` before submitting a sentence. Events use the merged shared union, including Part 1's call status and optional client speech fallback, and correlate by sentence `id`. The debug route emits transcript first. Gate rejection ends without a verdict. An `UNCLEAR` verdict may have no evidence, and `confidence: 0` on a provider failure means no usable judgment was obtained. Detailed reasons remain structured server logs. Live events are not replayed on reconnect; maintain dashboard state while connected.

`npm run fixtures` generates `fixtures/events.json`, explicitly using synthetic responses. These fixtures exercise orchestration and provide a UI replay; their outcomes do not measure model accuracy. Fixture excerpts are hand-authored examples, not stored live source quotations.

## Verification and practical limits

- `npm run typecheck`, `npm test`, and `npm run build` pass. The 39 tests cover provider wire contracts, missing/malformed confidence, retries disabled, HTTP validation/fast acknowledgement, real WS delivery/shutdown, cancellation, cooldown races, and local credential precedence.
- `npm run fixtures` passes all 30 synthetic expectations. Eleven inputs are intentionally gated out, including the unresolved reference to "this city". Gate fixtures require a resolvable subject.
- `npm run fixtures -- --live --demo` passes all three initial demo beats. On the recorded run, true/false checks took about 956/899 ms respectively. Only two checks are in that latency sample; it does not establish general performance.
- `npm run smoke` passes through a real local HTTP listener, `/debug/sentence`, `/live`, both providers, and a recording test speaker. The two classified claims took approximately 1,063/816 ms; exactly one correction was recorded. Vapi was not invoked.
- The latest 30-input live batch matched 22 expected outcomes: 11 inputs were ignored, 14 received model judgments, and five searches timed out. Three time-sensitive/compound-claim judgments differed from the conservative `UNCLEAR` labels. Completed-judgment p50/p95 were 985/1,797 ms (14 samples). No false spoken correction was recorded; only one correction reached the test speaker. The run exits nonzero and is not claimed as a passing accuracy evaluation. See the checked-in [validation summary](part-2-validation.json).

Gate `0.85` and voice `0.95` remain conservative working settings. In the final tuning split, gate thresholds 0.70 through 0.90 made no gate errors; 0.95 missed one claim. Voice threshold 0.85 admitted one false candidate before excerpt/cooldown checks; 0.90 and above excluded it while keeping six expected contradiction candidates. Retain 0.85/0.95 for the MVP. Comparisons use only the tuning split and never silently change configuration. The heldout subset is reported separately: a time-sensitive heldout claim produced a 0.96 contradiction, suppressed by the excerpt check. This is direct evidence that confidence alone is insufficient. The sample does not establish calibration or general correctness.

Jev timeouts are now 1,000 ms per stage, the total brain deadline is 3,000 ms, and cold boot warm-up gets 5,000 ms per provider. Exa remains 900 ms with no retries or automatic slower fallback, preserving the agreed live behavior. Overall sub-second performance and reliable coverage across arbitrary claims are still open quality targets. Actual audio integration and venue rehearsal belong to Parts 1 and 3.

The initial authentication failure was traced to an inherited environment variable overriding `.env`. The explicit local configuration loader fixes that failure mode; both providers now authenticate with the locally configured keys. No API keys or raw provider error bodies are committed.
