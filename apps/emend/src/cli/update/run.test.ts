import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { pollUntil } from "../../test/poll-until.ts";
import { runChild } from "./run.ts";
import { UpdateSignals } from "./signals.ts";

test.each(["inherit", "capture"] as const)(
  "forwards parent signals to a %s child and removes handlers",
  async (output) => {
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      const dir = await mkdtemp(join(process.env.EMEND_HOME as string, "signals-"));
      const ready = join(dir, "ready");
      const received = join(dir, "received");
      const before = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
      const signals = new UpdateSignals();
      try {
        const pending = runChild(
          process.execPath,
          [
            "-e",
            `const fs = require("node:fs");
        process.on(${JSON.stringify(signal)}, () => { fs.writeFileSync(${JSON.stringify(received)}, ${JSON.stringify(signal)}); process.exit(0); });
        fs.writeFileSync(${JSON.stringify(ready)}, "ready"); setInterval(() => {}, 1000);`,
          ],
          { cwd: dir, env: {}, timeoutMs: 10000, output, signals },
        );
        await pollUntil(async () => expect(await readFile(ready, "utf8")).toBe("ready"));
        process.emit(signal);
        expect((await pending).interrupted).toBe(signal);
        expect(await readFile(received, "utf8")).toBe(signal);
      } finally {
        signals.dispose();
      }
      expect([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")]).toEqual(before);
    }
  },
);

test("kills an interrupted child after five seconds if it ignores the forwarded signal", async () => {
  const dir = await mkdtemp(join(process.env.EMEND_HOME as string, "signals-"));
  const ready = join(dir, "ready");
  const signals = new UpdateSignals();
  try {
    const pending = runChild(
      process.execPath,
      [
        "-e",
        `const fs = require("node:fs");
      process.on("SIGTERM", () => {}); fs.writeFileSync(${JSON.stringify(ready)}, "ready"); setInterval(() => {}, 1000);`,
      ],
      { cwd: dir, env: {}, timeoutMs: 10000, output: "capture", signals },
    );
    await pollUntil(async () => expect(await readFile(ready, "utf8")).toBe("ready"));
    vi.useFakeTimers();
    process.emit("SIGTERM");
    await vi.advanceTimersByTimeAsync(4999);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    vi.useRealTimers();
    const result = await pending;
    expect(result.interrupted).toBe("SIGTERM");
    expect(result.signal).toBe("SIGKILL");
  } finally {
    vi.useRealTimers();
    signals.dispose();
  }
});

test("records the first signal between children and starts no subsequent child", async () => {
  const signals = new UpdateSignals();
  try {
    process.emit("SIGINT");
    process.emit("SIGTERM");
    expect(signals.interrupted).toBe("SIGINT");
    const result = await runChild("/never-run", [], {
      cwd: "/tmp",
      env: {},
      timeoutMs: 1000,
      output: "capture",
      signals,
    });
    expect(result.interrupted).toBe("SIGINT");
    expect(result.error).toBe(false);
  } finally {
    signals.dispose();
  }
});
