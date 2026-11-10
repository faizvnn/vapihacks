import { mkdir, writeFile } from "node:fs/promises";
import { loadConfig, pipelineDefaults } from "../src/config.js";
import { createExa } from "../src/exa.js";
import { createJev } from "../src/jev.js";
import { createPipeline } from "../src/pipeline.js";
import type { Event, LogRecord, VerdictLabel } from "../src/types.js";
import { fixtureProviders, loadFixtures } from "./fixture-support.js";

export function percentile(values: number[], fraction: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round((sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? 0) * 10) / 10;
}
async function main() {
  const args = process.argv.slice(2);
  const live = args.includes("--live");
  const demo = args.includes("--demo");
  const { fixtures: all, responses } = await loadFixtures();
  const fixtures = demo ? all.filter((fixture) => fixture.demo) : all;
  const config = live ? loadConfig() : pipelineDefaults;
  const providers = live
    ? { jev: createJev(loadConfig()), exa: createExa(loadConfig().exaApiKey) }
    : fixtureProviders(fixtures, responses);
  const events: Event[] = [];
  const logs: LogRecord[] = [];
  const rows: Record<string, unknown>[] = [];
  const counts = { failures: 0, dropped: 0, ignored: 0, duplicates: 0, falseSpoken: 0, mismatches: 0 };
  let warmup: Record<string, string> | undefined;
  if (live) {
    // The real boot warm-up is bounded identically. Import lazily to keep mock runs key-free.
    const { createApp } = await import("../src/app.js");
    const runtime = createApp({ config: loadConfig(), ...providers });
    await runtime.warmUp();
    warmup = (await runtime.app.inject({ method: "GET", url: "/ready" })).json().providers;
    await runtime.app.close();
  }
  const pipeline = createPipeline({ ...providers, config, publish: (event) => events.push(event), logger: (record) => logs.push(record), say: async () => {} });
  try {
    for (const fixture of fixtures) {
      events.push({ type: "transcript", id: fixture.id, text: fixture.text, final: true });
      await pipeline.onSentence({ id: fixture.id, text: fixture.text, context: fixture.context ?? [], t: Date.now() });
      const gate = events.find((event) => event.type === "gate" && event.id === fixture.id);
      const verdict = events.find((event) => event.type === "verdict" && event.id === fixture.id);
      const completion = logs.find((record) => record.id === fixture.id && record.stage === "complete");
      const stageMs = (stage: string) => Math.round(logs.find((record) => record.id === fixture.id && record.stage === stage)?.ms ?? 0);
      const gateMatches = gate?.type === "gate" && gate.passed === fixture.expectedGate;
      const verdictMatches = !fixture.expectedGate || (verdict?.type === "verdict" && verdict.verdict === fixture.expectedVerdict);
      const matches = gateMatches && verdictMatches;
      if (!matches) counts.mismatches++;
      if (verdict?.type === "verdict" && verdict.spoken && fixture.expectedVerdict !== "CONTRADICTED") counts.falseSpoken++;
      if (completion?.reason === "not_a_claim") counts.ignored++;
      else if (completion?.reason === "duplicate") counts.duplicates++;
      else if (completion?.reason === "overloaded") counts.dropped++;
      else if (completion?.reason && completion.reason !== "no_evidence") counts.failures++;
      rows.push({
        id: fixture.id, split: fixture.split,
        p: gate?.type === "gate" ? Math.round(gate.p * 1000) / 1000 : null,
        expected: fixture.expectedVerdict ?? "IGNORED",
        verdict: verdict?.type === "verdict" ? verdict.verdict : gate?.type === "gate" && !gate.passed ? "IGNORED" : "FAILED",
        confidence: verdict?.type === "verdict" ? verdict.confidence : null,
        spoken: verdict?.type === "verdict" ? verdict.spoken : false,
        gateMs: stageMs("gate"), searchMs: stageMs("search"), verdictMs: stageMs("verdict"),
        totalMs: verdict?.type === "verdict" ? Math.round(verdict.totalMs) : null,
        reason: completion?.reason ?? completion?.speechSuppression ?? "",
        match: matches,
      });
    }
  } finally { pipeline.close(); }
  const completed = events.filter((event) => event.type === "verdict" && event.confidence > 0);
  const times = completed.map((event) => event.type === "verdict" ? event.totalMs : 0);
  const summary = {
    mode: live ? "live" : "mock (synthetic responses; NOT model accuracy)",
    measuredAt: new Date().toISOString(), model: live ? loadConfig().jevModel : "synthetic",
    thresholds: { gate: config.gateThreshold, voice: config.voiceThreshold },
    evaluated: fixtures.length, completedChecks: times.length,
    p50Ms: percentile(times, 0.5), p95Ms: percentile(times, 0.95), ...counts, warmup,
    realVoiceDispatched: false,
  };
  console.table(rows);
  console.log(JSON.stringify(summary, null, 2));
  await mkdir("outputs", { recursive: true });
  const name = `${live ? "live" : "mock"}${demo ? "-demo" : ""}`;
  await writeFile(`outputs/${name}-fixtures.json`, JSON.stringify({ summary, rows, events, logs }, null, 2));
  // Stable replay for Part 3 is always generated from the full deterministic run.
  if (!live && !demo) await writeFile("fixtures/events.json", JSON.stringify(events, null, 2));
  if (counts.mismatches || counts.falseSpoken) process.exitCode = 1;
}
main().catch(() => { console.error("Fixture runner failed. Check configuration and output directory permissions."); process.exitCode = 1; });
