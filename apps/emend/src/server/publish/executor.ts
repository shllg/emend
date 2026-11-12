import { Worker } from "node:worker_threads";
import type { DocLinks } from "@emend/core";
import type { Executor, Work } from "./work.ts";

export type WorkerMessage = Work | { kind: "doc-context"; docs: DocLinks | undefined };

export class WorkTimeout extends Error {}
export type WorkerExecutor = Executor & { close(): Promise<void> };
export function workerExecutor(timeouts = { render: 10000, place: 30000 }): WorkerExecutor {
  let worker: Worker | undefined;
  let workerDocs: DocLinks | undefined;
  let busy = false;
  const close = async () => {
    const current = worker;
    worker = undefined;
    workerDocs = undefined;
    if (current) await current.terminate();
  };
  const execute: Executor = (work) =>
    new Promise((resolve, reject) => {
      if (busy) {
        reject(new Error("Worker already busy"));
        return;
      }
      busy = true;
      if (!worker) {
        workerDocs = undefined;
        worker = new Worker(
          new URL(import.meta.url.endsWith(".ts") ? "./worker.ts" : "./publish-worker.mjs", import.meta.url),
          {
            // Deep author nesting relies on Node's default 4 MB worker stack.
            resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32, stackSizeMb: 4 },
          },
        );
        const created = worker;
        // Exits while idle must also invalidate the cached worker without an unhandled error.
        created.on("error", () => {});
        created.once("exit", () => {
          if (worker === created) worker = undefined;
        });
      }
      const current = worker;
      const finish = () => {
        clearTimeout(timer);
        current.removeListener("message", message);
        current.removeListener("error", failed);
        current.removeListener("exit", failed);
        busy = false;
        current.unref();
      };
      const failed = () => {
        finish();
        void close();
        reject(new Error("Worker failed"));
      };
      const message = (value: { ok: boolean; result: Awaited<ReturnType<Executor>> }) => {
        if (!value?.ok) {
          failed();
          return;
        }
        finish();
        resolve(value.result);
      };
      const timer = setTimeout(
        () => {
          finish();
          void close();
          reject(new WorkTimeout());
        },
        work.kind === "place" || work.kind === "placement-doc" ? timeouts.place : timeouts.render,
      );
      current.once("message", message);
      current.once("error", failed);
      current.once("exit", failed);
      current.ref();
      try {
        const buffers =
          work.kind === "diff-counts"
            ? [work.old, work.next].filter((buffer): buffer is ArrayBuffer => buffer !== null)
            : work.kind === "doc" || work.kind === "source"
              ? [work.source]
              : work.kind === "doc-metadata" ||
                  work.kind === "resection" ||
                  work.kind === "placement-doc" ||
                  work.kind === "writeup-source" ||
                  work.kind === "line-count"
                ? [work.bytes]
                : work.kind === "changed"
                  ? [...work.previous.map((blob) => blob.bytes), ...work.next]
                  : work.kind === "writeup"
                    ? (work.mediaHeads ?? []).map(([, head]) => head)
                    : work.kind === "place"
                      ? [
                          ...work.texts.values(),
                          ...[...(work.parsedDocs?.values() ?? [])].map((doc) => doc.bytes),
                          ...(work.parsedWriteup ? [work.parsedWriteup.bytes] : []),
                        ]
                      : [];
        if (work.kind === "doc" || work.kind === "writeup") {
          const { docs, ...job } = work;
          // Each revision owns one immutable map. Transport it once per worker, including
          // after a restart, and replace/clear it when another revision or bare job arrives.
          if (docs !== workerDocs) {
            current.postMessage({ kind: "doc-context", docs } satisfies WorkerMessage);
            workerDocs = docs;
          }
          current.postMessage(job, [...new Set(buffers)]);
        } else current.postMessage(work, [...new Set(buffers)]);
      } catch {
        failed();
      }
    });
  return Object.assign(execute, { close });
}
