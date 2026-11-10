import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { WebSocket } from "ws";
import { createApp } from "../src/app.js";
import { createBus } from "../src/bus.js";
import { loadConfig } from "../src/config.js";
import type { Event, Exa, Jev } from "../src/types.js";
import { deferred, evidence, flush, judgment, sentence } from "./helpers.js";

const config = () => loadConfig({ TYPESAFE_API_KEY: "test-key", EXA_API_KEY: "test-key" });
const providers = (): { jev: Jev; exa: Exa } => ({
  jev: { async gate() { return { p: 0.99 }; }, async judge() { return judgment(); } },
  exa: { async search() { return evidence; } },
});

test("debug route validates requests, responds before remote work, and emits transcript first", async (t) => {
  const gate = deferred<{ p: number }>();
  const deps = providers(); deps.jev.gate = () => gate.promise;
  const runtime = createApp({ config: config(), ...deps });
  t.after(() => runtime.app.close());
  const events: Event[] = []; runtime.bus.subscribe((event) => events.push(event));
  for (const payload of [{}, { text: " " }, { text: "a".repeat(2001) }, { text: "A claim.", context: ["a", "b", "c"] }]) {
    assert.equal((await runtime.app.inject({ method: "POST", url: "/debug/sentence", payload })).statusCode, 400);
  }
  assert.equal(events.length, 0);
  const response = await runtime.app.inject({ method: "POST", url: "/debug/sentence", payload: { text: "A factual claim." } });
  assert.equal(response.statusCode, 202);
  const id = response.json().id;
  assert.equal(typeof id, "string"); assert.equal(events.length, 1);
  assert.deepEqual(events[0], { type: "transcript", id, text: "A factual claim.", final: true });
  gate.resolve({ p: 0.99 }); await flush();
  assert.deepEqual(events.map((event) => event.type), ["transcript", "gate", "evidence", "verdict"]);
});

test("readiness changes after one bounded, silent provider warmup", async (t) => {
  let gates = 0; let searches = 0;
  const deps = providers();
  deps.jev.gate = async () => { gates++; return { p: 0.99 }; };
  deps.exa.search = async () => { searches++; return evidence; };
  const runtime = createApp({ config: config(), ...deps }); t.after(() => runtime.app.close());
  const events: Event[] = []; runtime.bus.subscribe((event) => events.push(event));
  assert.equal((await runtime.app.inject({ url: "/health" })).statusCode, 200);
  assert.equal((await runtime.app.inject({ url: "/ready" })).statusCode, 503);
  await Promise.all([runtime.warmUp(), runtime.warmUp()]);
  const response = await runtime.app.inject({ url: "/ready" });
  assert.equal(response.statusCode, 200); assert.equal(response.json().voiceConnected, false);
  assert.equal(gates, 1); assert.equal(searches, 1); assert.equal(events.length, 0);
});

test("provider warmup failure degrades readiness but leaves debug input usable", async (t) => {
  const deps = providers(); deps.jev.gate = async () => { throw new Error("provider failed"); };
  const runtime = createApp({ config: config(), ...deps }); t.after(() => runtime.app.close());
  await runtime.warmUp();
  const response = await runtime.app.inject({ url: "/ready" });
  assert.equal(response.statusCode, 503); assert.equal(response.json().providers.jev, "unavailable");
  assert.equal((await runtime.app.inject({ method: "POST", url: "/debug/sentence", payload: { text: "A claim." } })).statusCode, 202);
});

test("fresh session uses stable pipeline facade and suppresses previous session's late work", async (t) => {
  const gate = deferred<{ p: number }>(); let gates = 0;
  const deps = providers(); deps.jev.gate = async () => ++gates === 1 ? gate.promise : { p: 0.99 };
  const runtime = createApp({ config: config(), ...deps }); t.after(() => runtime.app.close());
  const events: Event[] = []; runtime.bus.subscribe((event) => events.push(event));
  const facade = runtime.pipeline;
  const first = facade.onSentence(sentence("same")); await flush();
  runtime.resetSession(); await first;
  await facade.onSentence(sentence("same")); gate.resolve({ p: 0.99 }); await flush();
  assert.equal(events.filter((e) => e.type === "verdict").length, 1);
});

test("event bus isolates failed subscribers", () => {
  const bus = createBus(); const events: Event[] = [];
  bus.subscribe(() => { throw new Error("broken listener"); });
  const unsubscribe = bus.subscribe((event) => events.push(event));
  bus.publish({ type: "jamie", text: "test", status: "done" });
  assert.equal(events.length, 1); unsubscribe();
  bus.publish({ type: "jamie", text: "test", status: "done" }); assert.equal(events.length, 1);
});

test("real WS clients receive events and HTTP shutdown terminates upgraded sockets", { timeout: 5000 }, async (t) => {
  const runtime = createApp({ config: config(), ...providers() });
  t.after(() => runtime.app.close());
  const address = await runtime.app.listen({ host: "127.0.0.1", port: 0 });
  const client = new WebSocket(address.replace("http:", "ws:") + "/live");
  t.after(() => client.terminate());
  await once(client, "open");
  const event: Event = { type: "transcript", id: "a", text: "A claim.", final: true };
  const received = once(client, "message"); runtime.bus.publish(event);
  assert.deepEqual(JSON.parse(String((await received)[0])), event);
  const closed = once(client, "close"); await runtime.app.close(); await closed;
});
