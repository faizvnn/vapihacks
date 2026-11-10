import { EventEmitter } from "node:events";
import type { Event } from "./types.js";

export const bus = new EventEmitter();
bus.setMaxListeners(100);

export function emit(e: Event) {
  bus.emit("event", e);
}
