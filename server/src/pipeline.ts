import { bounded } from "./async.js";
import { pipelineDefaults, validatePipelineConfig, type PipelineConfig } from "./config.js";
import { createCorrectionPolicy } from "./correction-policy.js";
import { systemClock, type Clock, type Event, type Exa, type Jev, type Judgment, type Logger, type Pipeline, type Sentence } from "./types.js";
import { PipelineError, probability, safeError, validEvidence, validJudgment, validSentence } from "./validation.js";

type Entry = { at: number; active: boolean };
type Job = {
  s: Sentence;
  key: string;
  started: number;
  controller: AbortController;
  terminal: boolean;
};
export function normalize(text: string): string {
  return text.normalize("NFKC").toLowerCase().trim().replace(/\s+/g, " ").replace(/[.!?]+$/, "");
}
export function claimKey(s: Sentence): string {
  return JSON.stringify([normalize(s.text), ...s.context.map(normalize)]);
}
export type PipelineDependencies = {
  jev: Jev;
  exa: Exa;
  publish: (event: Event) => void;
  say?: (text: string) => Promise<void>;
  config?: Partial<PipelineConfig>;
  clock?: Clock;
  logger?: Logger;
};

export function createPipeline(deps: PipelineDependencies): Pipeline {
  const config = validatePipelineConfig({ ...pipelineDefaults, ...deps.config });
  const clock = deps.clock ?? systemClock;
  const session = new AbortController();
  const active = new Map<string, Job>();
  const ids = new Map<string, Entry>();
  const claims = new Map<string, Entry>();
  const speech = createCorrectionPolicy(config, deps.say ?? (() => Promise.reject(new PipelineError("speaker_unavailable"))), clock);
  const log = (record: Parameters<Logger>[0]) => { try { deps.logger?.(record); } catch { /* Logging cannot fail the webhook. */ } };
  const publish = (event: Event) => {
    if (!session.signal.aborted) {
      try { deps.publish(event); } catch { log({ stage: "publish", reason: "publication_failed" }); }
    }
  };
  function prune(map: Map<string, Entry>) {
    const now = clock.now();
    for (const [key, entry] of map) if (!entry.active && now - entry.at >= config.dedupTtlMs) map.delete(key);
    for (const [key, entry] of map) {
      if (map.size < config.dedupMaxEntries) break;
      if (!entry.active) map.delete(key);
    }
  }
  function finish(job: Job, retain: boolean) {
    if (job.terminal) return false;
    job.terminal = true;
    active.delete(job.s.id);
    if (retain) {
      const completed = { at: clock.now(), active: false };
      ids.set(job.s.id, completed);
      claims.set(job.key, completed);
    } else {
      // IDs still suppress retries of the same webhook; semantic failures may be checked under a fresh ID.
      ids.set(job.s.id, { at: clock.now(), active: false });
      claims.delete(job.key);
    }
    return true;
  }
  function fail(job: Job, reason: string, status?: number) {
    if (!finish(job, false)) return;
    job.controller.abort(new PipelineError(reason));
    log({ id: job.s.id, stage: "complete", ms: clock.now() - job.started, reason, status, verdict: "UNCLEAR", confidence: 0 });
    publish({ type: "verdict", id: job.s.id, verdict: "UNCLEAR", confidence: 0, spoken: false, totalMs: clock.now() - job.started });
  }
  const alive = (job: Job) => !job.terminal && !job.controller.signal.aborted && !session.signal.aborted;

  async function stage<T>(job: Job, name: "gate" | "search" | "verdict", timeout: number, run: (signal: AbortSignal) => Promise<T>) {
    const start = clock.now();
    try {
      const remaining = config.totalTimeoutMs - (start - job.started);
      if (remaining <= 0) throw new PipelineError("total_timeout");
      return await bounded(run, Math.min(timeout, remaining), `${name}_timeout`, job.controller.signal, clock);
    } finally { log({ id: job.s.id, stage: name, ms: clock.now() - start }); }
  }

  async function execute(job: Job) {
    const overall = clock.setTimeout(() => fail(job, "total_timeout"), config.totalTimeoutMs);
    try {
      let start = clock.now();
      const gate = await stage(job, "gate", config.gateTimeoutMs, (signal) => deps.jev.gate(job.s, signal));
      if (!alive(job)) return;
      if (!probability(gate?.p)) throw new PipelineError("invalid_gate_response");
      const passed = gate.p >= config.gateThreshold;
      publish({ type: "gate", id: job.s.id, p: gate.p, passed, ms: clock.now() - start });
      if (!alive(job)) return;
      if (!passed) { finish(job, true); log({ id: job.s.id, stage: "complete", reason: "not_a_claim" }); return; }

      start = clock.now();
      const evidence = await stage(job, "search", config.searchTimeoutMs, (signal) => deps.exa.search(job.s, signal));
      if (!alive(job)) return;
      if (!evidence) { fail(job, "no_evidence"); return; }
      if (!validEvidence(evidence)) throw new PipelineError("invalid_evidence");
      publish({ type: "evidence", id: job.s.id, ...evidence, ms: clock.now() - start });
      if (!alive(job)) return;

      const judgment = await stage(job, "verdict", config.verdictTimeoutMs, (signal) => deps.jev.judge(job.s, evidence, signal));
      if (!alive(job)) return;
      if (!validJudgment(judgment)) throw new PipelineError("invalid_verdict_response");
      const totalMs = clock.now() - job.started;
      if (!finish(job, true)) return;
      clock.clearTimeout(overall);
      const speechStart = clock.now();
      const result = await speech.dispatch(judgment, evidence, session.signal);
      log({ id: job.s.id, stage: "speech", ms: clock.now() - speechStart, speechSuppression: result.reason });
      log({ id: job.s.id, stage: "complete", ms: totalMs, verdict: judgment.verdict, confidence: judgment.confidence, speechSuppression: result.reason });
      publish({ type: "verdict", id: job.s.id, verdict: judgment.verdict, confidence: judgment.confidence, spoken: result.spoken, totalMs });
    } catch (error) {
      const failure = safeError(error);
      fail(job, failure.reason, failure.status);
    } finally {
      clock.clearTimeout(overall);
    }
  }

  return {
    async onSentence(input) {
      if (session.signal.aborted) return;
      if (!validSentence(input)) { log({ stage: "admission", reason: "invalid_sentence" }); return; }
      // Copy input so caller mutations cannot change queued state or deduplication keys.
      const s: Sentence = { ...input, context: [...input.context] };
      prune(ids);
      prune(claims);
      const key = claimKey(s);
      if (ids.has(s.id) || claims.has(key)) { log({ id: s.id, stage: "admission", reason: "duplicate" }); return; }
      if (active.size >= config.maxInFlight) {
        const oldest = active.values().next().value;
        if (oldest) fail(oldest, "overloaded");
      }
      const job: Job = { s, key, started: clock.now(), controller: new AbortController(), terminal: false };
      const entry = { at: clock.now(), active: true };
      ids.set(s.id, entry);
      claims.set(key, entry);
      active.set(s.id, job);
      await execute(job);
    },
    close() {
      if (session.signal.aborted) return;
      session.abort(new PipelineError("session_closed"));
      for (const job of active.values()) {
        job.terminal = true;
        job.controller.abort(new PipelineError("session_closed"));
      }
      active.clear();
      ids.clear();
      claims.clear();
    },
  };
}
