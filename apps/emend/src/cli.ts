const statusLine = process.argv.length === 4 && process.argv[2] === "status" && process.argv[3] === "--line";
const statusLineController = statusLine ? new AbortController() : undefined;
if (statusLineController) {
  const rawDeadline = process.env.EMEND_STATUS_LINE_DEADLINE_MS ?? "";
  const deadline = /^\d+$/.test(rawDeadline) ? Number(rawDeadline) : NaN;
  setTimeout(
    () => {
      statusLineController.abort();
      // process.exit waits for blocked libuv workers; SIGKILL ends every thread.
      process.kill(process.pid, "SIGKILL");
    },
    Number.isInteger(deadline) && deadline >= 100 && deadline <= 10000 ? deadline : 2000,
  ).unref();
}
let refusal: string | undefined;
if (
  statusLine ||
  ["publish", "look", "wait", "feedback", "reply", "mcp", "stop", "service", "update", "skills"].includes(
    process.argv[2] ?? "",
  )
) {
  try {
    const { runtimeInRepository } = await import("./cli/runtime-repository.ts");
    const { cliRuntime } = await import("./cli/runtime.ts");
    const { escapeReference } = await import("./cli/escape.ts");
    const path = await runtimeInRepository(cliRuntime(), process.cwd());
    if (path)
      refusal =
        "emend: this emend runs from inside the current repository (" +
        escapeReference(path) +
        "); run emend from an install outside the repository.\n";
  } catch {
    refusal = "emend: could not check where this emend runs; nothing was changed.\n";
  }
}
if (refusal) {
  if (statusLine) process.exit(0);
  process.stderr.write(refusal);
  process.exitCode = 1;
} else {
  const { run } = await import("./main.ts");
  // The callback reports failed writes; consume the matching stream error event too.
  if (statusLine || ["wait", "feedback", "reply", "mcp", "serve"].includes(process.argv[2] ?? ""))
    process.stdout.on("error", () => {});
  const serving = process.argv[2] === "serve";
  if (serving) process.stderr.on("error", () => {});
  process.exitCode = await run(process.argv.slice(2), {
    statusLineSignal: statusLineController?.signal,
    isTTY: process.stdout.isTTY === true,
    stdout: (s) => {
      try {
        process.stdout.write(s);
      } catch (error) {
        if (!serving) throw error;
      }
    },
    stdoutAsync: (s) =>
      new Promise<void>((resolve, reject) => {
        // Publish also awaits its write. Its guard exists only for this write; a
        // failed callback is followed by the matching stream error event.
        const consumeError = () => {};
        process.stdout.once("error", consumeError);
        process.stdout.write(s, (error) => {
          if (error) reject(error);
          else {
            process.stdout.off("error", consumeError);
            resolve();
          }
        });
      }),
    stdin: process.stdin,
    stderr: (s) => {
      try {
        process.stderr.write(s);
      } catch (error) {
        if (!serving) throw error;
      }
    },
    env: process.env,
  });
  if (statusLine) process.exit(process.exitCode ?? 0);
}
// A pending stdout write can keep the event loop alive after an interrupted flush.
// Serve has already finished its startup and process-group cleanup before returning.
if (process.exitCode === 129 || process.exitCode === 130 || process.exitCode === 131 || process.exitCode === 143)
  process.exit(process.exitCode);
