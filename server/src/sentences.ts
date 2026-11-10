import type { Sentence } from "./types.js";

const MIN_WORDS = Number(process.env.MIN_SENTENCE_WORDS ?? 4);
const FLUSH_MS = 1500;

const words = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;

/**
 * Turns Deepgram "final" utterances into whole sentences.
 * - splits on . ! ?
 * - pieces shorter than MIN_WORDS get merged into the next piece
 * - a short leftover waits up to FLUSH_MS for more words, then goes out anyway
 */
export class SentenceSplitter {
  private pending = "";
  private history: string[] = [];
  private n = 0;
  private timer: NodeJS.Timeout | null = null;

  constructor(private onSentence: (s: Sentence) => void) {}

  push(finalText: string) {
    if (this.timer) clearTimeout(this.timer);
    const text = `${this.pending} ${finalText}`.replace(/\s+/g, " ").trim();
    this.pending = "";

    const pieces = text.split(/(?<=[.!?])\s+/).filter(Boolean);
    let carry = "";
    for (const piece of pieces) {
      const candidate = carry ? `${carry} ${piece}` : piece;
      if (words(candidate) < MIN_WORDS) {
        carry = candidate;
        continue;
      }
      this.out(candidate);
      carry = "";
    }
    if (carry) {
      this.pending = carry;
      this.timer = setTimeout(() => this.flush(), FLUSH_MS);
    }
  }

  flush() {
    if (this.pending) this.out(this.pending);
    this.pending = "";
  }

  reset() {
    this.pending = "";
    this.history = [];
    if (this.timer) clearTimeout(this.timer);
  }

  private out(text: string) {
    const s: Sentence = {
      id: `s${++this.n}`,
      text,
      context: this.history.slice(-2),
      t: Date.now(),
    };
    this.history.push(text);
    if (this.history.length > 10) this.history.shift();
    this.onSentence(s);
  }
}
