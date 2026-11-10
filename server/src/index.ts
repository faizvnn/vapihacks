import { createApp } from "./app.js";
import cors from "@fastify/cors";
import { readFile } from "node:fs/promises";
import { loadConfig } from "./config.js";
import { createExa } from "./exa.js";
import { createJev } from "./jev.js";
import type { Logger } from "./types.js";
import { registerVapiRoutes, say } from "./vapi.js";

async function main() {
  const config = loadConfig();
  const logger: Logger = (record) => process.stdout.write(`${JSON.stringify(record)}\n`);
  const runtime = createApp({ config, jev: createJev(config, logger), exa: createExa(config.exaApiKey, logger), say, logger, httpLogging: true, bodyLimit: 20 * 1024 * 1024 });
  await runtime.app.register(cors, { origin: true });
  registerVapiRoutes(runtime.app, {
    onSentence: runtime.pipeline.onSentence,
    onCallStarted: runtime.resetSession,
    onCallEnded: runtime.pipeline.close,
    publish: runtime.bus.publish,
    debugSentence: false,
  });
  // Preserve the Part 1 voice test page in development and in the compiled build.
  runtime.app.get("/test", async (_request, reply) => reply.type("text/html").send(
    await readFile(new URL("../../server/public/test.html", import.meta.url), "utf8")
      .catch(() => readFile(new URL("../public/test.html", import.meta.url), "utf8")),
  ));
  const shutdown = () => { void runtime.app.close().catch(() => { process.exitCode = 1; }); };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  await runtime.app.listen({ host: config.host, port: config.port });
  await runtime.warmUp();
}

main().catch(() => {
  // Config/provider errors may contain secret values; emit only an actionable, bounded message.
  console.error("Startup failed. Check .env keys, numeric settings, and whether PORT is available.");
  process.exitCode = 1;
});
