import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import { bounded } from "./async.js";
import { attachLive, createBus } from "./bus.js";
import type { Config } from "./config.js";
import { createPipeline } from "./pipeline.js";
import type { Exa, Jev, Logger, Sentence } from "./types.js";
import { safeError } from "./validation.js";

export function createApp(options: {
  config: Config;
  jev: Jev;
  exa: Exa;
  say?: (text: string) => Promise<void>;
  logger?: Logger;
  httpLogging?: boolean;
}) {
  const app = Fastify({ logger: options.httpLogging ?? false, bodyLimit: 16384 });
  const logger: Logger = options.logger ?? ((record) => app.log.info(record));
  const bus = createBus(logger);
  const makePipeline = () => createPipeline({ ...options, logger, publish: bus.publish });
  let pipeline = makePipeline();
  let closing = false;
  const lifetime = new AbortController();
  const readiness = { jev: "pending", exa: "pending" };
  let warming: Promise<void> | undefined;
  const closeLive = attachLive(app.server, bus);

  app.get("/health", async () => ({ status: "ok" }));
  app.get("/ready", async (_request, reply) => {
    const ready = readiness.jev === "ready" && readiness.exa === "ready";
    return reply.code(ready ? 200 : 503).send({ status: ready ? "ready" : "degraded", providers: readiness, voiceConnected: Boolean(options.say) });
  });
  app.post<{ Body: { text: string; context?: string[] } }>("/debug/sentence", {
    schema: {
      body: {
        type: "object", required: ["text"], additionalProperties: false,
        properties: {
          text: { type: "string", minLength: 1, maxLength: 2000, pattern: "\\S" },
          context: { type: "array", maxItems: 2, items: { type: "string", minLength: 1, maxLength: 2000, pattern: "\\S" } },
        },
      },
    },
  }, async (request, reply) => {
    if (closing) return reply.code(503).send({ error: "Server is closing" });
    const s: Sentence = { id: randomUUID(), text: request.body.text, context: request.body.context ?? [], t: Date.now() };
    bus.publish({ type: "transcript", id: s.id, text: s.text, final: true });
    void pipeline.onSentence(s);
    return reply.code(202).send({ id: s.id });
  });
  // Terminate upgraded sockets before Fastify waits for the HTTP server to close.
  app.addHook("preClose", async () => {
    closing = true;
    lifetime.abort();
    pipeline.close();
    closeLive();
  });

  return {
    app, bus,
    // A stable facade lets Part 1 import one reference across call boundaries.
    pipeline: {
      onSentence: (s: Sentence) => pipeline.onSentence(s),
      close: () => pipeline.close(),
    },
    resetSession() {
      if (closing) return;
      pipeline.close(); pipeline = makePipeline();
    },
    warmUp(): Promise<void> {
      if (warming) return warming;
      const s: Sentence = { id: "warmup", text: "Paris is the capital of France.", context: [], t: Date.now() };
      warming = Promise.all([
        bounded((signal) => options.jev.gate(s, signal), options.config.warmupTimeoutMs, "warmup_timeout", lifetime.signal)
          .then(() => { readiness.jev = "ready"; }, (error: unknown) => {
            readiness.jev = "unavailable"; logger({ stage: "warmup_jev", ...safeError(error) });
          }),
        bounded((signal) => options.exa.search(s, signal), options.config.warmupTimeoutMs, "warmup_timeout", lifetime.signal)
          .then((evidence) => { readiness.exa = evidence ? "ready" : "no_evidence"; }, (error: unknown) => {
            readiness.exa = "unavailable"; logger({ stage: "warmup_exa", ...safeError(error) });
          }),
      ]).then(() => {});
      return warming;
    },
  };
}
