import { vi } from "vitest";
import type * as executors from "../server/publish/executor.ts";
import { executeWork } from "../server/publish/work.ts";

/**
 * Runs publish work in the test thread instead of a cold worker thread, for tests whose subject is
 * not the worker. The test file must first replace the executor module with a copy that can be
 * spied on: `vi.mock("<path>/server/publish/executor.ts", async (original) => ({ ...(await original<typeof import("<path>/server/publish/executor.ts")>()) }))`.
 * A test whose subject is the worker, or the production wiring that picks it, does not call this.
 */
export function workInThread(module: typeof executors) {
  return vi
    .spyOn(module, "workerExecutor")
    .mockImplementation(() =>
      Object.assign((work: Parameters<typeof executeWork>[0]) => executeWork(work), { close: async () => {} }),
    );
}
