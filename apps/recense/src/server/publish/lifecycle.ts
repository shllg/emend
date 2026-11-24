import { ApiError } from "../http/errors.ts";

export class PublishAborted extends ApiError {
  constructor() {
    super("invalid_request", "publish_aborted");
  }
}
export function checkPublishSignal(signal?: AbortSignal) {
  if (signal?.aborted) throw new PublishAborted();
}
export async function abortable<T>(signal: AbortSignal | undefined, operation: () => Promise<T>): Promise<T> {
  checkPublishSignal(signal);
  if (!signal) return operation();
  const aborted = Promise.withResolvers<never>();
  const stop = () => aborted.reject(new PublishAborted());
  signal.addEventListener("abort", stop, { once: true });
  try {
    return await Promise.race([operation(), aborted.promise]);
  } finally {
    signal.removeEventListener("abort", stop);
  }
}

export function createPublishSlots(capacity = 2, timeoutMs = 30000) {
  let active = 0;
  const waiting: (() => void)[] = [];
  function release() {
    active--;
    waiting.shift()?.();
  }
  return {
    async acquire(signal?: AbortSignal): Promise<() => void> {
      checkPublishSignal(signal);
      if (active < capacity) {
        active++;
        return release;
      }
      return new Promise((resolve, reject) => {
        const cleanup = () => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", stop);
          const index = waiting.indexOf(enter);
          if (index !== -1) waiting.splice(index, 1);
        };
        const enter = () => {
          cleanup();
          active++;
          resolve(release);
        };
        const stop = () => {
          cleanup();
          reject(new PublishAborted());
        };
        const timer = setTimeout(() => {
          cleanup();
          reject(new ApiError("rate_limited", "publish_busy"));
        }, timeoutMs);
        signal?.addEventListener("abort", stop, { once: true });
        waiting.push(enter);
      });
    },
  };
}
export const publishSlots = createPublishSlots();
