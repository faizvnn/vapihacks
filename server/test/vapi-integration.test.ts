import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import type { Event } from "../src/types.js";
import { registerVapiRoutes } from "../src/vapi.js";
import { evidence, flush, judgment } from "./helpers.js";

test("Part 1 routes feed the real pipeline, share events, and reset its call lifecycle", async (t) => {
  const corrections: string[] = [];
  const runtime = createApp({
    config: loadConfig({ TYPESAFE_API_KEY: "test-key", EXA_API_KEY: "test-key" }),
    jev: { async gate() { return { p: 0.99 }; }, async judge() { return judgment("CONTRADICTED"); } },
    exa: { async search() { return evidence; } },
    say: async (text) => { corrections.push(text); },
  });
  t.after(() => runtime.app.close());
  registerVapiRoutes(runtime.app, {
    onSentence: runtime.pipeline.onSentence,
    onCallStarted: runtime.resetSession,
    onCallEnded: runtime.pipeline.close,
    publish: runtime.bus.publish,
    debugSentence: false,
  });
  const events: Event[] = [];
  runtime.bus.subscribe((event) => events.push(event));
  const post = (message: unknown) => runtime.app.inject({ method: "POST", url: "/vapi/webhook", payload: { message } });
  // Supplying a control URL avoids any external Vapi lookup in this test.
  const call = { id: "integration-call-one", monitor: { controlUrl: "https://example.org/control" } };
  assert.equal((await post({ type: "status-update", status: "in-progress", call })).statusCode, 200);
  assert.equal((await post({ type: "transcript", role: "user", transcriptType: "final", transcript: "Paris is the capital of Germany.", call })).statusCode, 200);
  await flush();
  const transcript = events.find((event) => event.type === "transcript");
  const verdict = events.find((event) => event.type === "verdict");
  assert.ok(transcript?.type === "transcript" && verdict?.type === "verdict");
  assert.equal(verdict.id, transcript.id);
  assert.equal(verdict.verdict, "CONTRADICTED");
  assert.equal(verdict.spoken, true);
  assert.equal(corrections.length, 1);

  await post({ type: "status-update", status: "ended", call });
  const count = events.length;
  await runtime.pipeline.onSentence({ id: "after-end", text: "A different factual claim.", context: [], t: 0 });
  assert.equal(events.length, count);
  const secondCall = { ...call, id: "integration-call-two" };
  await post({ type: "status-update", status: "in-progress", call: secondCall });
  await post({ type: "transcript", role: "user", transcriptType: "final", transcript: "Paris is the capital of Germany.", call: secondCall });
  await flush();
  assert.equal(corrections.length, 2);

  // Both silent-LLM response modes remain compatible, and /debug/sentence is registered once.
  const json = await runtime.app.inject({ method: "POST", url: "/silent/chat/completions", payload: {} });
  assert.equal(json.json().choices[0].message.content, "");
  const stream = await runtime.app.inject({ method: "POST", url: "/silent/chat/completions", payload: { stream: true } });
  assert.equal(stream.body.includes("data: [DONE]"), true);
  assert.equal((await runtime.app.inject({ url: "/assistant" })).statusCode, 200);
  assert.equal((await runtime.app.inject({ method: "POST", url: "/debug/sentence", payload: { text: "Another factual claim." } })).statusCode, 202);
});
