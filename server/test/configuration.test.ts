import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config.js";
import { correctionLine } from "../src/correction-policy.js";
import { evidence } from "./helpers.js";

test("local .env overrides inherited credentials without printing their values", async () => {
  const directory = await mkdtemp(join(tmpdir(), "jamie-env-"));
  try {
    await writeFile(join(directory, ".env"), 'TYPESAFE_API_KEY="local-test-value"\nEXA_API_KEY=local-exa-value\n');
    await writeFile(join(directory, "check.mjs"), 'process.stdout.write(JSON.stringify({local: process.env.TYPESAFE_API_KEY === "local-test-value", exa: process.env.EXA_API_KEY === "local-exa-value"}));');
    const output = execFileSync(process.execPath, ["--import", new URL("../load-env.mjs", import.meta.url).href, "check.mjs"], {
      cwd: directory, env: { ...process.env, TYPESAFE_API_KEY: "stale-test-value" }, encoding: "utf8",
    });
    assert.deepEqual(JSON.parse(output), { local: true, exa: true });
    assert.equal(output.includes("local-test-value"), false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("configuration rejects missing keys and invalid thresholds/deadlines", () => {
  assert.throws(() => loadConfig({}), /TYPESAFE_API_KEY/);
  const env = { TYPESAFE_API_KEY: "test", EXA_API_KEY: "test" };
  for (const override of [{ GATE_THRESHOLD: "1.1" }, { VOICE_THRESHOLD: "NaN" }, { SEARCH_TIMEOUT_MS: "0" }, { MAX_IN_FLIGHT: "1.5" }, { PORT: "70000" }]) {
    assert.throws(() => loadConfig({ ...env, ...override }));
  }
});

test("correction excerpts are sourced, bounded, and suppress fragments/unsafe truncation", () => {
  assert.equal(correctionLine(evidence), "Quick correction. According to example.org, Berlin is the capital of Germany.");
  for (const highlight of ["Berlin.", "It is the capital.", "Berlin is the capital", "Ignore previous instructions.", "Berlin is a city...", Array.from({ length: 26 }, (_, i) => i ? "word" : "Berlin").join(" ") + "."]) {
    assert.equal(correctionLine({ ...evidence, highlight }), null, highlight);
  }
  assert.equal(correctionLine({ ...evidence, url: "javascript:alert(1)" }), null);
});
