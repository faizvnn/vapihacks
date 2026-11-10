import { readFile } from "node:fs/promises";
import type { Evidence, Exa, Jev, Judgment, Sentence, VerdictLabel } from "../src/types.js";

export type Fixture = {
  id: string; text: string; context?: string[]; expectedGate: boolean;
  expectedVerdict?: VerdictLabel; split: "tune" | "heldout"; demo?: boolean;
};
export type FixtureResponses = {
  banterProbability: number; claimProbability: number; verdictConfidence: number;
  evidenceById: Record<string, Evidence | null>;
};
export async function loadFixtures(): Promise<{ fixtures: Fixture[]; responses: FixtureResponses }> {
  return {
    fixtures: JSON.parse(await readFile(new URL("../../fixtures/sentences.json", import.meta.url), "utf8")),
    responses: JSON.parse(await readFile(new URL("../../fixtures/provider-responses.json", import.meta.url), "utf8")),
  };
}
export function fixtureProviders(fixtures: Fixture[], responses: FixtureResponses): { jev: Jev; exa: Exa } {
  const byId = new Map(fixtures.map((fixture) => [fixture.id, fixture]));
  const find = (s: Sentence) => {
    const fixture = byId.get(s.id);
    if (!fixture) throw new Error("Unknown fixture");
    return fixture;
  };
  return {
    jev: {
      async gate(s) { return { p: find(s).expectedGate ? responses.claimProbability : responses.banterProbability }; },
      async judge(s) {
        const verdict = find(s).expectedVerdict ?? "UNCLEAR";
        const judgment: Judgment = {
          verdict, confidence: responses.verdictConfidence,
          probabilities: { CONFIRMED: 0.005, CONTRADICTED: 0.005, UNCLEAR: 0.005, [verdict]: 0.99 },
        };
        return judgment;
      },
    },
    exa: { async search(s) { find(s); return responses.evidenceById[s.id] ?? null; } },
  };
}
