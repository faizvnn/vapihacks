import { mkdir, writeFile } from "node:fs/promises";
import { bounded } from "../src/async.js";
import { loadConfig } from "../src/config.js";
import { correctionLine } from "../src/correction-policy.js";
import { createExa } from "../src/exa.js";
import { createJev } from "../src/jev.js";
import { safeError } from "../src/validation.js";
import type { Sentence } from "../src/types.js";

async function main() {
  const config = loadConfig();
  const jev = createJev(config);
  const exa = createExa(config.exaApiKey);
  const s: Sentence = { id: "spike", text: "Paris is the capital of Germany.", context: [], t: Date.now() };
  const rows: Record<string, unknown>[] = [];
  // A generous spike deadline distinguishes transport/auth problems from live-path latency misses.
  async function measure<T>(stage: string, run: (signal: AbortSignal) => Promise<T>) {
    const started = performance.now();
    try {
      const result = await bounded(run, 15000, "spike_timeout");
      rows.push({ stage, ok: true, ms: Math.round(performance.now() - started) });
      return result;
    } catch (error) {
      rows.push({ stage, ok: false, ms: Math.round(performance.now() - started), ...safeError(error) });
      return undefined;
    }
  }
  const gate = await measure("gate", (signal) => jev.gate(s, signal));
  const evidence = await measure("search", (signal) => exa.search(s, signal));
  const judgment = evidence ? await measure("verdict", (signal) => jev.judge(s, evidence, signal)) : undefined;
  const report = {
    measuredAt: new Date().toISOString(), model: config.jevModel, rows,
    gate: gate?.p ?? null, evidence: evidence ?? null, judgment: judgment ?? null,
    correction: evidence ? correctionLine(evidence) : null,
    // No real speaker is connected in this script.
    voiceDispatched: false,
  };
  console.table(rows);
  console.log(JSON.stringify({ gate: report.gate, source: evidence?.url, judgment, correction: report.correction }, null, 2));
  await mkdir("outputs", { recursive: true });
  await writeFile("outputs/spike.json", JSON.stringify(report, null, 2));
  if (!gate || !evidence || !judgment) process.exitCode = 1;
}
main().catch(() => { console.error("Spike could not run. Check .env configuration."); process.exitCode = 1; });
