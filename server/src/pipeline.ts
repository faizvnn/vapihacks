// STUB — Part 2 replaces this file with the real gate -> search -> verdict -> decide.
// Keep the export shape: `pipeline.onSentence(s)` and import `say` from ./vapi.js.
import { emit } from "./bus.js";
import { say } from "./vapi.js";
import type { Sentence } from "./types.js";

export const pipeline = {
  async onSentence(s: Sentence): Promise<void> {
    const hasNumber = /\d/.test(s.text);
    emit({ type: "gate", id: s.id, p: hasNumber ? 0.95 : 0.1, passed: hasNumber, ms: 1 });
    if (!hasNumber) return;
    console.log(`[stub] claim detected: "${s.text}"`);
    if (process.env.STUB_SPEAK === "1") await say("Claim detected.");
  },
};
