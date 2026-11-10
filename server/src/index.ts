import Fastify from "fastify";
import cors from "@fastify/cors";
import { WebSocketServer } from "ws";
import { readFileSync } from "node:fs";
import { bus } from "./bus.js";
import { registerVapiRoutes } from "./vapi.js";
import type { Event } from "./types.js";

const PORT = Number(process.env.PORT ?? 8787);
if (!process.env.PUBLIC_URL) console.warn("!! PUBLIC_URL not set — Vapi can't reach /silent or /vapi/webhook");

const app = Fastify({ bodyLimit: 20 * 1024 * 1024 });
await app.register(cors, { origin: true });

registerVapiRoutes(app);

const testPage = new URL("../public/test.html", import.meta.url);
app.get("/test", async (_req, reply) => reply.type("text/html").send(readFileSync(testPage)));
app.get("/health", async () => ({ ok: true }));

await app.listen({ port: PORT, host: "0.0.0.0" });

// WS /live — fan out every bus event to all dashboards
const wss = new WebSocketServer({ server: app.server, path: "/live" });
bus.on("event", (e: Event) => {
  const data = JSON.stringify(e);
  for (const c of wss.clients) if (c.readyState === 1) c.send(data);
});
wss.on("connection", () => console.log(`[ws] dashboard connected (${wss.clients.size})`));

console.log(`Jamie server on :${PORT}  test page: http://localhost:${PORT}/test`);
