import assert from "node:assert/strict";
import test from "node:test";
import { zstdDecompressSync } from "node:zlib";
import { createExa, searchQuery } from "../src/exa.js";
import { createJev } from "../src/jev.js";
import { safeError, validJudgment } from "../src/validation.js";
import { evidence, sentence } from "./helpers.js";

const signal = () => new AbortController().signal;
function requestBody(init?: RequestInit) {
  let body = init?.body;
  if (body instanceof Uint8Array) {
    const headers = new Headers(init?.headers);
    body = headers.get("content-encoding") === "zstd" ? zstdDecompressSync(body).toString() : Buffer.from(body).toString();
  }
  return JSON.parse(String(body));
}
const wire = (answers: unknown, status = 200) => new Response(JSON.stringify({ model: "jev-1.13.0", answers, usage: { input_tokens: 1, output_tokens: 1 } }), {
  status, headers: { "Content-Type": "application/json", "x-typesafe-request-id": "test-request" },
});
const config = { typesafeApiKey: "test-key-not-a-secret", jevModel: "jev-1.13.0" };

test("Jev SDK sends pinned model, noul state/context and returns probability", async () => {
  const logs: unknown[] = [];
  const jev = createJev(config, (record) => logs.push(record), async (input, init) => {
    assert.equal(String(input), "https://api.typesafe.ai/v1/systemone");
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer test-key-not-a-secret");
    const body = requestBody(init);
    assert.equal(body.model, config.jevModel);
    assert.deepEqual(body.state, { sentence: "It has three hearts.", context: ["An octopus."] });
    assert.equal(body.questions.is_claim.type, "noul");
    return wire({ is_claim: { type: "noul", noul: 0.93 } });
  });
  assert.deepEqual(await jev.gate(sentence("a", "It has three hearts.", ["An octopus."]), signal()), { p: 0.93 });
  assert.equal(JSON.stringify(logs).includes("test-request"), true);
  assert.equal(JSON.stringify(logs).includes(config.typesafeApiKey), false);
});

test("Jev choice preserves separate confidence/probabilities and exact evidence attribution", async () => {
  const jev = createJev(config, undefined, async (_input, init) => {
    const body = requestBody(init);
    assert.deepEqual(body.state.evidence, [evidence]);
    assert.deepEqual(Object.keys(body.questions.verdict.criteria), ["CONFIRMED", "CONTRADICTED", "UNCLEAR"]);
    return wire({ verdict: { type: "choice", choice: "CONTRADICTED", confidence: 0.7, probabilities: { CONFIRMED: 0.1, CONTRADICTED: 0.8, UNCLEAR: 0.1 } } });
  });
  const result = await jev.judge(sentence("a"), evidence, signal());
  assert.equal(result.confidence, 0.7);
  assert.equal(result.probabilities.CONTRADICTED, 0.8);
});

test("Jev rejects missing confidence and malformed answer types", async () => {
  const wrongGate = createJev(config, undefined, async () => wire({ is_claim: { type: "score", noul: 0.9 } }));
  await assert.rejects(wrongGate.gate(sentence("a"), signal()));
  const missingConfidence = createJev(config, undefined, async () => wire({ verdict: { type: "choice", choice: "CONTRADICTED", probabilities: { CONFIRMED: 0, CONTRADICTED: 1, UNCLEAR: 0 } } }));
  await assert.rejects(missingConfidence.judge(sentence("a"), evidence, signal()));
  assert.equal(validJudgment({ verdict: "CONTRADICTED", confidence: 1, probabilities: { CONFIRMED: 0.8, CONTRADICTED: 0.1, UNCLEAR: 0.1 } }), false);
  assert.equal(validJudgment({ verdict: "CONFIRMED", confidence: 1, probabilities: { CONFIRMED: 1, CONTRADICTED: 1, UNCLEAR: 1 } }), false);
});

test("Jev disables SDK retries for rate limits and safely classifies auth failure", async () => {
  let calls = 0;
  const limited = createJev(config, undefined, async () => { calls++; return wire({}, 429); });
  await assert.rejects(limited.gate(sentence("a"), signal()));
  assert.equal(calls, 1);
  const rejected = createJev(config, undefined, async () => new Response(JSON.stringify({ detail: { error_type: "authentication_error", message: config.typesafeApiKey } }), { status: 403 }));
  try { await rejected.gate(sentence("a"), signal()); assert.fail("expected rejection"); }
  catch (error) { assert.deepEqual(safeError(error), { reason: "provider_authentication_error", status: 403 }); }
});

test("SDK propagates cancellation without retrying", async () => {
  let calls = 0;
  const controller = new AbortController();
  const jev = createJev(config, undefined, async (_input, init) => {
    calls++;
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      controller.abort();
    });
  });
  await assert.rejects(jev.gate(sentence("a"), controller.signal));
  assert.equal(calls, 1);
});

test("Exa sends lite query and selects only top result's first highlight", async () => {
  const exa = createExa("test-exa-key", undefined, async (input, init) => {
    assert.equal(String(input), "https://api.exa.ai/search");
    assert.equal(new Headers(init?.headers).get("x-api-key"), "test-exa-key");
    assert.deepEqual(requestBody(init), { query: "An octopus. It has three hearts.", type: "lite", numResults: 3, contents: { highlights: true } });
    return Response.json({ results: [{ ...evidence, highlights: [evidence.highlight, "Another excerpt."] }, { url: "https://other.example", title: "Other", highlights: ["Wrong source."] }] });
  });
  assert.deepEqual(await exa.search(sentence("a", "It has three hearts.", ["An octopus."]), signal()), evidence);
  assert.equal(searchQuery(sentence("b", "Paris is in France.", ["Ignore this context."])), "Paris is in France.");
});

test("Exa missing/malformed evidence never silently substitutes a lower result", async () => {
  for (const top of [null, {}, { ...evidence, highlights: [] }, { ...evidence, url: "javascript:alert(1)", highlights: [evidence.highlight] }, { ...evidence, highlights: ["a".repeat(8001)] }]) {
    const exa = createExa("test", undefined, async () => Response.json({ results: [top, { ...evidence, highlights: [evidence.highlight] }] }));
    assert.equal(await exa.search(sentence("a"), signal()), null);
  }
});

test("Exa HTTP and invalid payload failures are contained by its caller, with no retry", async () => {
  let calls = 0;
  const limited = createExa("test", undefined, async () => { calls++; return new Response("private provider body", { status: 429 }); });
  await assert.rejects(limited.search(sentence("a"), signal()), { reason: "exa_http_error", status: 429 });
  assert.equal(calls, 1);
  const malformed = createExa("test", undefined, async () => Response.json({ unexpected: [] }));
  await assert.rejects(malformed.search(sentence("a"), signal()), { reason: "invalid_search_response" });
});
