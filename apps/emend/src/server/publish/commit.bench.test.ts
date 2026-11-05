import { monitorEventLoopDelay } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { PublishResponse } from "@emend/contract";
import { expect, test, vi } from "vitest";
import { emitBench } from "../bench-support.ts";
import { commitFixture, publishPhases } from "./commit-test-support.ts";

vi.mock("node:worker_threads", async (original) => {
  const module = await original<typeof import("node:worker_threads")>();
  return {
    ...module,
    Worker: class extends module.Worker {
      constructor(...args: ConstructorParameters<typeof module.Worker>) {
        super(args[1]?.eval ? args[0] : new URL("./commit-worker.fixture.ts", import.meta.url), args[1]);
      }
    },
  };
});

test("publish responsiveness at the block cap", async () => {
  const loop = monitorEventLoopDelay({ resolution: 1 });
  let monitoring = false;
  let phase = "idle";
  let monitor: Promise<void> | undefined;
  const preparations: Promise<void>[] = [];
  const samples: { phase: string; getMs: number; headMs: number }[] = [];
  const probe = async (label: string, start = performance.now()) => {
    const [getMs, headMs] = await Promise.all([
      Promise.resolve(f.get()).then((response) => {
        const elapsed = performance.now() - start;
        expect(response.status).toBe(200);
        return elapsed;
      }),
      Promise.resolve(f.head()).then((response) => {
        const elapsed = performance.now() - start;
        expect(response.status).toBe(204);
        return elapsed;
      }),
    ]);
    samples.push({ phase: label, getMs, headMs });
  };
  const f = await commitFixture(async (label, run) => {
    if (!monitoring) return run();
    phase = label;
    const pending = probe(label);
    try {
      return await run();
    } finally {
      await pending;
      phase = "prepare";
      preparations.push(probe("prepare"));
    }
  });
  const transaction = f.writer.transaction.bind(f.writer);
  let writerMs = 0;
  vi.spyOn(f.writer, "transaction").mockImplementation(async (fn, options) => {
    let entered = 0;
    const result = await transaction((q) => {
      entered = performance.now();
      return fn(q);
    }, options);
    writerMs += performance.now() - entered;
    return result;
  });
  try {
    loop.enable();
    monitoring = true;
    await delay(5);
    monitor = (async () => {
      while (monitoring) {
        const start = performance.now();
        const label = phase;
        await delay(5);
        await probe(label, start); // Include timer delay between explicit phase probes.
      }
    })();
    const start = performance.now();
    const response = await f.publish(true);
    const elapsedMs = performance.now() - start;
    await delay(5); // Include the final commit turn in the histogram.
    loop.disable();
    monitoring = false;
    await monitor;
    await Promise.all(preparations);
    expect(response.status).toBe(200);
    expect(PublishResponse.parse(await response.json()).unrendered).toEqual([]);
    for (const label of publishPhases) {
      const measured = samples.filter((sample) => sample.phase === label);
      expect(measured.length, label).toBeGreaterThan(0);
      emitBench({
        bench: "publish-responsiveness",
        phase: label,
        getMs: Math.max(...measured.map((sample) => sample.getMs)),
        headMs: Math.max(...measured.map((sample) => sample.headMs)),
      });
    }
    emitBench({ bench: "publish-responsiveness", phase: "total", eventLoopMaxMs: loop.max / 1e6, writerMs, elapsedMs });
  } finally {
    loop.disable();
    monitoring = false;
    try {
      await monitor;
      await Promise.all(preparations);
    } finally {
      vi.restoreAllMocks();
      await f.cleanup();
    }
  }
});
