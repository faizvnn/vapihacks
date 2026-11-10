import { systemClock, type Clock } from "./types.js";
import { PipelineError } from "./validation.js";

// Reject promptly even when a provider ignores cancellation. Consume late rejections too.
export function untilAborted<T>(start: () => Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve().then(() => {
      signal.throwIfAborted();
      return start();
    }).then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
export async function bounded<T>(
  start: (signal: AbortSignal) => Promise<T>,
  ms: number,
  reason: string,
  parent?: AbortSignal,
  clock: Clock = systemClock,
): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort(parent?.reason);
  if (parent?.aborted) abort();
  else parent?.addEventListener("abort", abort, { once: true });
  const timer = clock.setTimeout(() => controller.abort(new PipelineError(reason)), Math.max(0, ms));
  try { return await untilAborted(() => start(controller.signal), controller.signal); }
  finally {
    clock.clearTimeout(timer);
    parent?.removeEventListener("abort", abort);
  }
}
