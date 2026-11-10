import assert from "node:assert/strict";
import test from "node:test";
import { claimKey, normalize } from "../src/pipeline.js";
import { PipelineError } from "../src/validation.js";
import { deferred, evidence, flush, judgment, sentence, setup, verdicts } from "./helpers.js";

test("confirmed claim emits gate, selected evidence, verdict in order without speech", async () => {
  const h = setup();
  await h.pipeline.onSentence(sentence("a"));
  assert.deepEqual(h.events.map((e) => e.type), ["gate", "evidence", "verdict"]);
  assert.equal(verdicts(h.events)[0]?.verdict, "CONFIRMED");
  assert.equal(verdicts(h.events)[0]?.spoken, false);
  assert.equal(h.spoken.length, 0);
  assert.equal(h.clock.tasks.size, 0);
});

test("banter ends after gate and never searches", async () => {
  let searches = 0;
  const h = setup({
    jev: { async gate() { return { p: 0.2 }; }, async judge() { throw new Error("must not judge"); } },
    exa: { async search() { searches++; return evidence; } },
  });
  await h.pipeline.onSentence(sentence("banter"));
  assert.equal(searches, 0);
  assert.deepEqual(h.events.map((e) => e.type), ["gate"]);
});

test("gate threshold is inclusive and voice threshold is strict", async () => {
  const h = setup({ jev: { async gate() { return { p: 0.85 }; }, async judge() { return judgment("CONTRADICTED", 0.95); } } });
  await h.pipeline.onSentence(sentence("edge"));
  assert.equal(verdicts(h.events)[0]?.verdict, "CONTRADICTED");
  assert.equal(h.spoken.length, 0);
});

test("missing evidence emits one UNCLEAR without fabricated evidence", async () => {
  const h = setup({ exa: { async search() { return null; } } });
  await h.pipeline.onSentence(sentence("missing"));
  assert.deepEqual(h.events.map((e) => e.type), ["gate", "verdict"]);
  assert.deepEqual(verdicts(h.events)[0], { type: "verdict", id: "missing", verdict: "UNCLEAR", confidence: 0, spoken: false, totalMs: 0 });
});

test("fourth check cancels oldest, settles promptly, and ignores its late response", async () => {
  const gates = Array.from({ length: 4 }, () => deferred<{ p: number }>());
  let calls = 0; const signals: AbortSignal[] = [];
  const h = setup({ jev: {
    async gate(_s, signal) { signals.push(signal); return gates[calls++]!.promise; },
    async judge() { return judgment(); },
  } });
  const jobs = ["a", "b", "c"].map((id) => h.pipeline.onSentence(sentence(id)));
  await flush(); jobs.push(h.pipeline.onSentence(sentence("d"))); await flush();
  await jobs[0];
  assert.equal(signals[0]?.aborted, true);
  assert.equal(verdicts(h.events).find((e) => e.id === "a")?.verdict, "UNCLEAR");
  gates.forEach((gate) => gate.resolve({ p: 0.99 }));
  await Promise.all(jobs);
  assert.equal(h.events.filter((e) => "id" in e && e.id === "a").length, 1);
  assert.equal(calls, 4); assert.equal(verdicts(h.events).length, 4);
});

test("stage timeout aborts transport and consumes late rejection", async () => {
  const gate = deferred<{ p: number }>(); let signal: AbortSignal | undefined;
  const h = setup({ config: { gateTimeoutMs: 20, totalTimeoutMs: 100 },
    jev: { async gate(_s, inputSignal) { signal = inputSignal; return gate.promise; }, async judge() { return judgment(); } },
  });
  const job = h.pipeline.onSentence(sentence("slow"));
  await flush(); h.clock.advance(20); await job;
  assert.equal(signal?.aborted, true);
  assert.equal(h.logs.find((r) => r.stage === "complete")?.reason, "gate_timeout");
  gate.reject(new Error("late transport failure")); await flush();
  assert.equal(verdicts(h.events).length, 1); assert.equal(h.clock.tasks.size, 0);
});

test("overall deadline bounds providers ignoring cancellation", async () => {
  const h = setup({ config: { totalTimeoutMs: 5 }, jev: { gate: () => new Promise(() => {}), async judge() { return judgment(); } } });
  const job = h.pipeline.onSentence(sentence("deadline"));
  await flush(); h.clock.advance(5); await job;
  assert.equal(h.logs.find((r) => r.stage === "complete")?.reason, "total_timeout");
  assert.equal(verdicts(h.events).length, 1);
});

test("search timeout never judges or speaks", async () => {
  let judged = false;
  const h = setup({ config: { searchTimeoutMs: 10 }, exa: { search: () => new Promise(() => {}) },
    jev: { async gate() { return { p: 0.99 }; }, async judge() { judged = true; return judgment(); } },
  });
  const job = h.pipeline.onSentence(sentence("search-slow"));
  await flush(); h.clock.advance(10); await job;
  assert.equal(judged, false); assert.equal(verdicts(h.events)[0]?.verdict, "UNCLEAR");
});

test("concurrent contradictions reserve exactly one speech dispatch", async () => {
  const accepted = deferred<void>(); let calls = 0;
  const h = setup({ say: () => { calls++; return accepted.promise; },
    jev: { async gate() { return { p: 0.99 }; }, async judge() { return judgment("CONTRADICTED"); } },
  });
  const first = h.pipeline.onSentence(sentence("a")); await flush();
  await h.pipeline.onSentence(sentence("b"));
  assert.equal(calls, 1); assert.equal(verdicts(h.events)[0]?.spoken, false);
  accepted.resolve(); await first;
  assert.equal(verdicts(h.events).filter((e) => e.spoken).length, 1);
});

test("cooldown permits exactly the 10-second boundary without queuing speech", async () => {
  const h = setup({ jev: { async gate() { return { p: 0.99 }; }, async judge() { return judgment("CONTRADICTED"); } } });
  await h.pipeline.onSentence(sentence("a"));
  h.clock.advance(9999); await h.pipeline.onSentence(sentence("b")); assert.equal(h.spoken.length, 1);
  h.clock.advance(1); await h.pipeline.onSentence(sentence("c")); assert.equal(h.spoken.length, 2);
});

test("speech failure preserves contradiction and consumes cooldown", async () => {
  let calls = 0;
  const h = setup({ say: async () => { calls++; throw new Error("transport failed"); },
    jev: { async gate() { return { p: 0.99 }; }, async judge() { return judgment("CONTRADICTED"); } },
  });
  await h.pipeline.onSentence(sentence("a")); await h.pipeline.onSentence(sentence("b"));
  assert.equal(calls, 1);
  assert.equal(verdicts(h.events).every((e) => e.verdict === "CONTRADICTED" && !e.spoken), true);
});

test("unsettled timed-out speech holds single-flight lock past cooldown", async () => {
  const accepted = deferred<void>(); let calls = 0;
  const h = setup({ say: () => { calls++; return accepted.promise; }, config: { speechTimeoutMs: 10 },
    jev: { async gate() { return { p: 0.99 }; }, async judge() { return judgment("CONTRADICTED"); } },
  });
  const first = h.pipeline.onSentence(sentence("a")); await flush(); h.clock.advance(10); await first;
  assert.equal(verdicts(h.events)[0]?.spoken, false);
  h.clock.advance(10000); await h.pipeline.onSentence(sentence("b")); assert.equal(calls, 1);
  accepted.resolve(); await flush(); await h.pipeline.onSentence(sentence("c")); assert.equal(calls, 2);
});

test("session close aborts work and forbids all late events and speech", async () => {
  const gate = deferred<{ p: number }>();
  const h = setup({ jev: { gate: () => gate.promise, async judge() { return judgment("CONTRADICTED"); } } });
  const job = h.pipeline.onSentence(sentence("a")); await flush(); h.pipeline.close(); await job;
  gate.resolve({ p: 0.99 }); await flush(); await h.pipeline.onSentence(sentence("b"));
  assert.equal(h.events.length, 0); assert.equal(h.spoken.length, 0); assert.equal(h.clock.tasks.size, 0);
});

test("close during speech suppresses terminal event after transport acceptance", async () => {
  const accepted = deferred<void>();
  const h = setup({ say: () => accepted.promise,
    jev: { async gate() { return { p: 0.99 }; }, async judge() { return judgment("CONTRADICTED"); } },
  });
  const job = h.pipeline.onSentence(sentence("a")); await flush(); h.pipeline.close(); await job;
  accepted.resolve(); await flush(); assert.equal(verdicts(h.events).length, 0);
});

test("dedup handles IDs and normalized text while preserving changed context", async () => {
  const h = setup();
  await h.pipeline.onSentence(sentence("a", "It has three hearts.", ["An octopus."]));
  await h.pipeline.onSentence(sentence("a", "Completely changed text."));
  await h.pipeline.onSentence(sentence("b", "  IT  has three hearts! ", ["An octopus."]));
  await h.pipeline.onSentence(sentence("c", "It has three hearts.", ["A different animal."]));
  assert.equal(verdicts(h.events).length, 2);
});

test("dedup expires and releases failed claims for fresh IDs", async () => {
  let searches = 0;
  const h = setup({ config: { dedupTtlMs: 10 }, exa: { async search() { return ++searches === 1 ? null : evidence; } } });
  await h.pipeline.onSentence(sentence("a", "Repeat this claim."));
  await h.pipeline.onSentence(sentence("b", "Repeat this claim.")); assert.equal(searches, 2);
  await h.pipeline.onSentence(sentence("c", "Repeat this claim.")); assert.equal(searches, 2);
  h.clock.advance(10); await h.pipeline.onSentence(sentence("c", "Repeat this claim.")); assert.equal(searches, 3);
});

test("dedup never evicts active reservations", async () => {
  const gate = deferred<{ p: number }>(); let calls = 0;
  const h = setup({ config: { dedupMaxEntries: 1 },
    jev: { gate: () => { calls++; return gate.promise; }, async judge() { return judgment(); } },
  });
  const a = h.pipeline.onSentence(sentence("a")); const b = h.pipeline.onSentence(sentence("b"));
  await flush(); await h.pipeline.onSentence(sentence("a")); assert.equal(calls, 2);
  gate.resolve({ p: 0.99 }); await Promise.all([a, b]);
});

test("normalization preserves numbers, polarity, and meaningful punctuation", () => {
  assert.notEqual(normalize("Rate is -1.2%."), normalize("Rate is 1.2%."));
  assert.notEqual(normalize("It is not true."), normalize("It is true."));
  assert.notEqual(claimKey(sentence("a", "It tripled.", ["Gold."])), claimKey(sentence("a", "It tripled.", ["Silver."])));
});

test("provider errors and malformed probabilities fail closed without exposing messages", async () => {
  for (const failure of [new PipelineError("provider_http_error", 429), new Error("sensitive provider body")]) {
    const h = setup({ jev: { async gate() { throw failure; }, async judge() { return judgment(); } } });
    await assert.doesNotReject(h.pipeline.onSentence(sentence("a")));
    assert.equal(verdicts(h.events)[0]?.verdict, "UNCLEAR");
    assert.equal(JSON.stringify(h.logs).includes("sensitive provider body"), false);
  }
  for (const p of [NaN, Infinity, -0.1, 1.1]) {
    const h = setup({ jev: { async gate() { return { p }; }, async judge() { return judgment(); } } });
    await h.pipeline.onSentence(sentence("a")); assert.equal(verdicts(h.events)[0]?.confidence, 0);
    assert.equal(h.events.some((e) => e.type === "gate"), false);
  }
});

test("invalid confidence cannot speak; model UNCLEAR keeps reported confidence", async () => {
  const h = setup({ jev: { async gate() { return { p: 0.99 }; }, async judge() { return judgment("CONTRADICTED", NaN); } } });
  await h.pipeline.onSentence(sentence("a")); assert.equal(verdicts(h.events)[0]?.confidence, 0); assert.equal(h.spoken.length, 0);
  const unclear = setup({ jev: { async gate() { return { p: 0.99 }; }, async judge() { return judgment("UNCLEAR", 0.8); } } });
  await unclear.pipeline.onSentence(sentence("b")); assert.equal(verdicts(unclear.events)[0]?.confidence, 0.8);
});

test("invalid input and publication/logging failures never reject caller", async () => {
  const h = setup();
  await h.pipeline.onSentence(sentence("a", " ")); await h.pipeline.onSentence(sentence("b", "A claim.", ["a", "b", "c"]));
  assert.equal(h.events.length, 0);
  const broken = setup({ publish: () => { throw new Error("failed"); }, logger: () => { throw new Error("failed"); } });
  await assert.doesNotReject(broken.pipeline.onSentence(sentence("a")));
});

test("totalMs excludes speech latency", async () => {
  const accepted = deferred<void>();
  const h = setup({ say: () => accepted.promise,
    jev: { async gate() { return { p: 0.99 }; }, async judge() { return judgment("CONTRADICTED"); } },
  });
  const job = h.pipeline.onSentence(sentence("a")); await flush(); h.clock.advance(100); accepted.resolve(); await job;
  assert.equal(verdicts(h.events)[0]?.totalMs, 0); assert.equal(h.logs.find((r) => r.stage === "speech")?.ms, 100);
});
