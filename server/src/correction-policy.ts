import type { PipelineConfig } from "./config.js";
import { bounded } from "./async.js";
import { systemClock, type Clock, type Evidence, type Judgment } from "./types.js";
import { safeError, validEvidence } from "./validation.js";

export function correctionLine(evidence: Evidence): string | null {
  if (!validEvidence(evidence)) return null;
  const segmenter = new Intl.Segmenter("en", { granularity: "sentence" });
  const first = segmenter.segment(evidence.highlight.trim())[Symbol.iterator]().next().value?.segment.trim();
  if (!first || !/[.!?]["')\]]?$/.test(first)) return null;
  const words = first.split(/\s+/).length;
  if (words < 3 || words > 25) return null;
  // Conservative extractive speech: don't read a dangling reference, fragment, command, or quotation.
  if (!/^[A-Z0-9]/.test(first) || /^(?:it|its|they|their|he|his|she|her|this|that|these|those|and|but|according|ignore|say|please)\b/i.test(first)
    || /(?:\.\.\.|…|https?:\/\/|[\r\n])/.test(first) || /[?:!]$/.test(first)) return null;
  const domain = new URL(evidence.url).hostname.replace(/^www\./, "");
  return `Quick correction. According to ${domain}, ${first}`;
}

export function createCorrectionPolicy(
  config: Pick<PipelineConfig, "voiceThreshold" | "voiceCooldownMs" | "speechTimeoutMs">,
  say: (text: string) => Promise<void>,
  clock: Clock = systemClock,
) {
  let reservedAt = -Infinity;
  let inFlight = false;
  return {
    async dispatch(judgment: Judgment, evidence: Evidence, signal: AbortSignal): Promise<{ spoken: boolean; reason?: string }> {
      if (signal.aborted) return { spoken: false, reason: "session_closed" };
      if (judgment.verdict !== "CONTRADICTED") return { spoken: false, reason: "not_contradicted" };
      if (judgment.confidence <= config.voiceThreshold) return { spoken: false, reason: "low_confidence" };
      const line = correctionLine(evidence);
      if (!line) return { spoken: false, reason: "no_safe_excerpt" };
      if (inFlight) return { spoken: false, reason: "speech_in_flight" };
      if (clock.now() - reservedAt < config.voiceCooldownMs) return { spoken: false, reason: "cooldown" };
      // Reserve before the first await. Do not release the lock if a timed-out transport is still unsettled.
      inFlight = true;
      reservedAt = clock.now();
      try {
        await bounded(async (dispatchSignal) => {
          dispatchSignal.throwIfAborted();
          try { await say(line); }
          finally { inFlight = false; }
        }, config.speechTimeoutMs, "speech_timeout", signal, clock);
        return { spoken: true };
      } catch (error) {
        return { spoken: false, reason: safeError(error).reason };
      }
    },
  };
}
