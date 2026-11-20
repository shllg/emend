import type { ParsedDiff } from "./FileDiff.tsx";
import ParseWorker from "./parse.worker.ts?worker";

export type ParseFile = { name: string; contents: string; cacheKey?: string };
export type ParsePair = { oldFile: ParseFile | null; newFile: ParseFile | null };
export type DiffParser = (pair: ParsePair, signal: AbortSignal) => ParsedDiff | Promise<ParsedDiff>;

// A cancellable worker per active parse: leaving the viewport also stops CPU work.
// The immutable result is cached by source scope and file id by the caller.
export function createParser(factory: () => Worker): DiffParser {
  return (pair, signal) =>
    new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(new DOMException("Aborted", "AbortError"));
        return;
      }
      const worker = factory();
      const finish = () => {
        signal.removeEventListener("abort", cancel);
        worker.terminate();
      };
      const cancel = () => {
        finish();
        reject(new DOMException("Aborted", "AbortError"));
      };
      const fail = () => {
        finish();
        reject(new Error("Could not parse this diff."));
      };
      worker.onmessage = ({ data }: MessageEvent<{ fileDiff?: ParsedDiff; error?: true }>) => {
        if (!data.fileDiff || data.error) {
          fail();
          return;
        }
        finish();
        resolve(data.fileDiff);
      };
      worker.onerror = (event) => {
        event.preventDefault();
        fail();
      };
      worker.onmessageerror = fail;
      signal.addEventListener("abort", cancel, { once: true });
      try {
        worker.postMessage(pair);
      } catch {
        fail();
      }
    });
}
export const parseOffThread = createParser(() => new ParseWorker());
