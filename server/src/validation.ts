import type { Evidence, Judgment, Sentence, VerdictLabel } from "./types.js";

export class PipelineError extends Error {
  constructor(readonly reason: string, readonly status?: number) { super(reason); }
}
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function probability(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}
export function validText(value: unknown, max = 2000): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max;
}
export function validSentence(value: unknown): value is Sentence {
  return isRecord(value) && validText(value.id, 200) && validText(value.text)
    && Array.isArray(value.context) && value.context.length <= 2
    && value.context.every((text: unknown) => validText(text))
    && typeof value.t === "number" && Number.isFinite(value.t);
}
export function validEvidence(value: unknown): value is Evidence {
  if (!isRecord(value) || !validText(value.url, 4000) || !validText(value.title, 2000)
    || !validText(value.highlight, 8000)) return false;
  try {
    const url = new URL(value.url);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password;
  } catch { return false; }
}
export const verdictLabels: VerdictLabel[] = ["CONFIRMED", "CONTRADICTED", "UNCLEAR"];
export function validJudgment(value: unknown): value is Judgment {
  if (!isRecord(value) || !verdictLabels.includes(value.verdict as VerdictLabel)
    || !probability(value.confidence) || !isRecord(value.probabilities)) return false;
  const probabilities = value.probabilities;
  return verdictLabels.every((label) => probability(probabilities[label]));
}
export function safeError(error: unknown): { reason: string; status?: number } {
  if (error instanceof PipelineError) return { reason: error.reason, status: error.status };
  // Never serialize provider errors: their messages/bodies may contain input or credentials.
  if (isRecord(error) && typeof error.status === "number") return { reason: "provider_http_error", status: error.status };
  return { reason: "provider_error" };
}
