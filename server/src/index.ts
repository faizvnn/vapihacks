import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createExa } from "./exa.js";
import { createJev } from "./jev.js";
import type { Logger } from "./types.js";

async function main() {
  const config = loadConfig();
  const logger: Logger = (record) => process.stdout.write(`${JSON.stringify(record)}\n`);
  const runtime = createApp({ config, jev: createJev(config, logger), exa: createExa(config.exaApiKey, logger), logger, httpLogging: true });
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
