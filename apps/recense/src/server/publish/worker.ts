import { parentPort } from "node:worker_threads";
import type { DocLinks } from "@recense/core";
import type { WorkerMessage } from "./executor.ts";
import { executeWork } from "./work.ts";

let docs: DocLinks | undefined;
parentPort?.on("message", async (work: WorkerMessage) => {
  if (work.kind === "doc-context") {
    docs = work.docs;
    return;
  }
  try {
    const result = await executeWork(work.kind === "doc" || work.kind === "writeup" ? { ...work, docs } : work);
    parentPort?.postMessage(
      { ok: true, result },
      "ids" in result ? [result.bytes, result.ids] : "bytes" in result ? [result.bytes] : [],
    );
  } catch {
    parentPort?.postMessage({ ok: false });
  }
});
