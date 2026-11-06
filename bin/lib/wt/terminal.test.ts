import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { markerTerminal } from "./github.ts";
import { ttyDevice } from "./terminal.ts";
import { terminal } from "./worktree.ts";

for (const [module, reader] of [
  ["github.ts", "markerTerminal"],
  ["worktree.ts", "terminal"],
]) {
  test(`R9.1: ${reader} real reader waits for late FIFO input without touching process.stdin`, async () => {
    const root = mkdtempSync(join(tmpdir(), "wt-tty-"));
    const fifo = join(root, "input");
    execFileSync("mkfifo", [fifo]);
    const writer = openSync(fifo, "r+");
    const source = `
      import { openSync } from 'node:fs';
      import { ttyDevice } from ${JSON.stringify(new URL("./terminal.ts", import.meta.url).href)};
      import { ${reader} } from ${JSON.stringify(new URL(`./${module}`, import.meta.url).href)};
      Object.defineProperty(process, 'stdin', { get() { throw new Error('stdin was touched'); } });
      ${reader}.stdinTTY?.();
      ${reader}.isTTY?.();
      ttyDevice.path = ${JSON.stringify(fifo)};
      ttyDevice.open = (path) => {
        const fd = openSync(path, 'r');
        process.stdout.write('ready\\n');
        return fd;
      };
      process.stdout.write(${reader}.readLine('') + '\\n');
    `;
    const child = spawn(process.execPath, ["--input-type=module", "-e", source], { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let error = "";
    child.stdout.on("data", (data) => {
      output += String(data);
    });
    child.stderr.on("data", (data) => {
      error += String(data);
    });
    const closed = once(child, "close");
    try {
      await Promise.race([
        once(child.stdout, "data"),
        closed.then(() => {
          throw new Error("reader exited before opening the test descriptor");
        }),
      ]);
      assert.equal(output, "ready\n");
      await delay(25); // Input deliberately arrives after the real blocking read begins.
      assert.equal(child.exitCode, null);
      writeSync(writer, "synthetic-answer\n");
      assert.deepEqual(await closed, [0, null]);
      assert.equal(output, "ready\nsynthetic-answer\n");
      assert.equal(error, "");
    } finally {
      child.kill();
      closeSync(writer);
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("R9.1: both prompts refuse when the controlling terminal cannot be opened", (t) => {
  assert.equal(ttyDevice.path, "/dev/tty");
  t.mock.method(ttyDevice, "open", () => {
    throw new Error("synthetic open failure");
  });
  assert.equal(markerTerminal.available(), false);
  assert.throws(() => markerTerminal.readLine("prompt"), {
    message: "--accept-new-markers needs an interactive terminal: the owner runs it there.",
  });
  assert.throws(() => terminal.readLine("prompt"), { message: "--discard needs a terminal. Nothing was removed." });
});

test("R9.1: both real readers write the prompt to their opened descriptor", () => {
  const root = mkdtempSync(join(tmpdir(), "wt-tty-prompt-"));
  const file = join(root, "terminal");
  const previous = ttyDevice.path;
  const prompt = "Type confirmation: ";
  try {
    ttyDevice.path = file;
    for (const reader of [markerTerminal, terminal]) {
      writeFileSync(file, `${" ".repeat(prompt.length)}synthetic-answer\n`);
      assert.equal(reader.readLine(prompt), "synthetic-answer");
      assert.equal(readFileSync(file, "utf8"), `${prompt}synthetic-answer\n`);
    }
  } finally {
    ttyDevice.path = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
