import { pipelineDefaults } from "../src/config.js";
import { createPipeline, type PipelineDependencies } from "../src/pipeline.js";
import type { Clock, Event, Evidence, Judgment, LogRecord, Sentence } from "../src/types.js";

export class ManualClock implements Clock {
  time = 0;
  nextId = 0;
  tasks = new Map<number, { at: number; fn: () => void }>();
  now = () => this.time;
  setTimeout = (fn: () => void, ms: number) => {
    const id = ++this.nextId;
    this.tasks.set(id, { at: this.time + ms, fn });
    return id;
  };
  clearTimeout = (id: unknown) => { this.tasks.delete(id as number); };
  advance(ms: number) {
    const target = this.time + ms;
    while (true) {
      const task = [...this.tasks.entries()].filter(([, task]) => task.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!task) break;
      this.time = task[1].at;
      this.tasks.delete(task[0]);
      task[1].fn();
    }
    this.time = target;
  }
}
export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
export async function flush() { for (let i = 0; i < 80; i++) await Promise.resolve(); }
export const evidence: Evidence = { url: "https://example.org/facts", title: "Country facts", highlight: "Berlin is the capital of Germany." };
export const judgment = (verdict: Judgment["verdict"] = "CONFIRMED", confidence = 0.99): Judgment => ({
  verdict, confidence, probabilities: { CONFIRMED: 0.005, CONTRADICTED: 0.005, UNCLEAR: 0.005, [verdict]: 0.99 },
});
export const sentence = (id: string, text = `Claim ${id} is factual.`, context: string[] = []): Sentence => ({ id, text, context, t: 1000 });
export function setup(overrides: Partial<PipelineDependencies> = {}) {
  const events: Event[] = [];
  const logs: LogRecord[] = [];
  const spoken: string[] = [];
  const clock = new ManualClock();
  const deps: PipelineDependencies = {
    jev: { async gate() { return { p: 0.99 }; }, async judge() { return judgment(); } },
    exa: { async search() { return evidence; } },
    publish: (event) => events.push(event), logger: (record) => logs.push(record),
    say: async (text) => { spoken.push(text); }, clock, config: pipelineDefaults, ...overrides,
  };
  const pipeline = createPipeline(deps);
  return { pipeline, events, logs, spoken, clock, deps };
}
export const verdicts = (events: Event[]) => events.filter((event) => event.type === "verdict");
