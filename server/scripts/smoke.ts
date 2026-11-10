import { once } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import { WebSocket } from "ws";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createExa } from "../src/exa.js";
import { createJev } from "../src/jev.js";
import type { Event } from "../src/types.js";

async function main() {
  const config = loadConfig();
  const corrections: string[] = [];
  // The speaker is a recording test double. This script never invokes Vapi.
  const runtime = createApp({ config, jev: createJev(config), exa: createExa(config.exaApiKey), say: async (text) => { corrections.push(text); } });
  const address = await runtime.app.listen({ host: "127.0.0.1", port: 0 });
  const client = new WebSocket(address.replace("http:", "ws:") + "/live");
  const events: Event[] = [];
  client.on("message", (data) => events.push(JSON.parse(String(data)) as Event));
  try {
    await once(client, "open");
    await runtime.warmUp();
    const readyResponse = await fetch(address + "/ready");
    const ready: unknown = await readyResponse.json();
    const outcomes: Event[] = [];
    for (const text of ["Paris is the capital of France.", "Paris is the capital of Germany."]) {
      // Register for events before starting the HTTP request: fast completion cannot race the response.
      const completion = new Promise<Event>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("smoke_timeout")), config.totalTimeoutMs + config.speechTimeoutMs + 1000);
        const listener = (data: unknown) => {
          const event = JSON.parse(String(data)) as Event;
          if (event.type === "verdict") {
            clearTimeout(timeout); client.off("message", listener); resolve(event);
          }
        };
        client.on("message", listener);
      });
      const response = await fetch(address + "/debug/sentence", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }) });
      if (response.status !== 202) throw new Error("debug_route_rejected");
      outcomes.push(await completion);
    }
    const passed = readyResponse.ok && outcomes[0]?.type === "verdict" && outcomes[0].verdict === "CONFIRMED"
      && outcomes[1]?.type === "verdict" && outcomes[1].verdict === "CONTRADICTED" && outcomes[1].spoken && corrections.length === 1;
    const report = { measuredAt: new Date().toISOString(), passed, readiness: ready, outcomes, corrections, events, realVoiceDispatched: false };
    await mkdir("outputs", { recursive: true });
    await writeFile("outputs/live-smoke.json", JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ passed, readiness: ready, outcomes, correctionCount: corrections.length, realVoiceDispatched: false }, null, 2));
    if (!passed) process.exitCode = 1;
  } finally {
    client.terminate();
    await runtime.app.close();
  }
}
main().catch(() => { console.error("Live HTTP/WS smoke failed; inspect outputs and provider readiness."); process.exitCode = 1; });
