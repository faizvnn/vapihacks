// Shared contract — frozen after kickoff. Change only with the whole team.

// Part 1 -> Part 2
export type Sentence = { id: string; text: string; context: string[]; t: number }; // context = previous 2 sentences

// Server -> dashboard, over WS /live
export type Event =
  | { type: "transcript"; id: string; text: string; final: boolean }
  | { type: "gate"; id: string; p: number; passed: boolean; ms: number }
  | { type: "evidence"; id: string; url: string; title: string; highlight: string; ms: number }
  | {
      type: "verdict";
      id: string;
      verdict: "CONFIRMED" | "CONTRADICTED" | "UNCLEAR";
      confidence: number;
      spoken: boolean;
      totalMs: number;
    }
  // clientShouldSpeak: set only when the server has no controlUrl (fallback d).
  // The browser then speaks the line via vapi.say(). The UI can ignore this field.
  | { type: "jamie"; text: string; status: "speaking" | "done"; clientShouldSpeak?: boolean }
  | { type: "call"; status: "starting" | "in-progress" | "ended"; control: boolean };
