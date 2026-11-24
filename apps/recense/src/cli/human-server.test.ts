import { randomBytes } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { StateDirModeError } from "../state/files.ts";
import { humanServer } from "./human-server.ts";

afterEach(() => vi.restoreAllMocks());

test("an unsafe state folder fails with the chmod hint before discovery", async () => {
  const stateDir = await mkdtemp(join(process.env.RECENSE_HOME as string, "human-server-mode-"));
  const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response());
  const kill = vi.spyOn(process, "kill");
  try {
    await writeFile(
      join(stateDir, "server.json"),
      JSON.stringify({ pid: process.pid, url: "http://127.0.0.1:3636", key: randomBytes(32).toString("base64url") }),
    );
    await chmod(stateDir, 0o770);
    const attempt = humanServer(stateDir);
    await expect(attempt).rejects.toBeInstanceOf(StateDirModeError);
    await expect(attempt).rejects.toThrow(`chmod 700 '${stateDir}'`);
    expect(kill).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});
