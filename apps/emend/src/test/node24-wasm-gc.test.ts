import { once } from "node:events";
import { Worker } from "node:worker_threads";
import { expect, onTestFinished, test } from "vitest";

const flag = "--no-wasm-code-gc";
const expected = process.versions.node.split(".")[0] === "24" ? [flag] : [];

test("fork workers disable wasm code GC exactly on Node 24", () => {
  expect(process.execArgv.filter((arg) => arg === flag)).toEqual(expected);
});

test("worker threads inherit the Node 24 wasm code GC workaround", async () => {
  const worker = new Worker('require("node:worker_threads").parentPort.postMessage(process.execArgv)', {
    eval: true,
  });
  onTestFinished(async () => {
    await worker.terminate();
  });
  const [[argv], [code]] = await Promise.all([once(worker, "message"), once(worker, "exit")]);
  expect((argv as string[]).filter((arg) => arg === flag)).toEqual(expected);
  expect(code).toBe(0);
});
