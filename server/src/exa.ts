import type { Exa, Logger, Sentence } from "./types.js";
import { isRecord, PipelineError, validEvidence } from "./validation.js";

export function searchQuery(s: Sentence): string {
  const needsContext = /^(?:and\b|but\b|it\b|its\b|they\b|their\b|he\b|his\b|she\b|her\b|this\b|that\b|these\b|those\b|the same\b|also\b|there\b)/i.test(s.text.trim());
  return needsContext && s.context.length ? [...s.context, s.text].join(" ") : s.text;
}

export function createExa(apiKey: string, logger: Logger = () => {}, fetcher: typeof fetch = fetch): Exa {
  return {
    async search(s, signal) {
      const response = await fetcher("https://api.exa.ai/search", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": apiKey },
        body: JSON.stringify({ query: searchQuery(s), type: "lite", numResults: 3, contents: { highlights: true } }),
        signal,
      });
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        throw new PipelineError("exa_http_error", response.status);
      }
      const body: unknown = await response.json();
      if (!isRecord(body) || !Array.isArray(body.results)) throw new PipelineError("invalid_search_response");
      if (typeof body.requestId === "string") logger({ id: s.id, stage: "exa_request", requestId: body.requestId });
      const top: unknown = body.results[0];
      if (!isRecord(top) || !Array.isArray(top.highlights)) return null;
      const evidence = { url: top.url, title: top.title, highlight: top.highlights[0] };
      return validEvidence(evidence) ? evidence : null;
    },
  };
}
