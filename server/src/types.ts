// Shared with Parts 1 and 3. Keep the wire shape aligned with README.md.
export type Sentence = { id: string; text: string; context: string[]; t: number };
export type VerdictLabel = "CONFIRMED" | "CONTRADICTED" | "UNCLEAR";
export type Event =
  | { type: "transcript"; id: string; text: string; final: boolean }
  | { type: "gate"; id: string; p: number; passed: boolean; ms: number }
  | { type: "evidence"; id: string; url: string; title: string; highlight: string; ms: number }
  | { type: "verdict"; id: string; verdict: VerdictLabel; confidence: number; spoken: boolean; totalMs: number }
  | { type: "jamie"; text: string; status: "speaking" | "done" };

export type Evidence = { url: string; title: string; highlight: string };
export type Judgment = {
  verdict: VerdictLabel;
  confidence: number;
  probabilities: Record<VerdictLabel, number>;
};
export interface Jev {
  gate(s: Sentence, signal: AbortSignal): Promise<{ p: number }>;
  judge(s: Sentence, e: Evidence, signal: AbortSignal): Promise<Judgment>;
}
export interface Exa {
  search(s: Sentence, signal: AbortSignal): Promise<Evidence | null>;
}
export interface Pipeline {
  onSentence(s: Sentence): Promise<void>;
  close(): void;
}
export type LogRecord = {
  id?: string;
  stage: string;
  ms?: number;
  reason?: string;
  verdict?: VerdictLabel;
  confidence?: number;
  speechSuppression?: string;
  requestId?: string;
  status?: number;
};
export type Logger = (record: LogRecord) => void;
export interface Clock {
  now(): number;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}
export const systemClock: Clock = {
  now: () => performance.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};
