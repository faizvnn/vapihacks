import { WebSocket, WebSocketServer } from "ws";
import type { Server } from "node:http";
import type { Event, Logger } from "./types.js";

export function createBus(logger: Logger = () => {}) {
  const listeners = new Set<(event: Event) => void>();
  return {
    subscribe(listener: (event: Event) => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    publish(event: Event) {
      for (const listener of listeners) {
        try { listener(event); } catch {
          try { logger({ stage: "publish", reason: "subscriber_failed" }); } catch { /* isolated */ }
        }
      }
    },
  };
}
export type Bus = ReturnType<typeof createBus>;

export function attachLive(server: Server, bus: Bus) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 8192 });
  server.on("upgrade", (request, socket, head) => {
    if (request.url !== "/live") { socket.destroy(); return; }
    wss.handleUpgrade(request, socket, head, (client) => {
      client.on("error", () => client.terminate());
      // /live is server-to-client only.
      client.on("message", () => {});
    });
  });
  const unsubscribe = bus.subscribe((event) => {
    const payload = JSON.stringify(event);
    for (const client of wss.clients) {
      try {
        if (client.readyState !== WebSocket.OPEN) continue;
        if (client.bufferedAmount > 512 * 1024) { client.terminate(); continue; }
        client.send(payload, (error) => { if (error) client.terminate(); });
      } catch { client.terminate(); }
    }
  });
  return () => {
    unsubscribe();
    for (const client of wss.clients) client.terminate();
    wss.close();
  };
}
