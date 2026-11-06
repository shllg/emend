import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, onTestFinished, test, vi } from "vitest";
import type { Io } from "../../main.ts";
import { type ServiceRunner, serviceTool } from "./common.ts";
import { launchdServerPid } from "./launchd.ts";

test.each([0, 113, 1, 112, "ENOENT"])("launchd ownership query handles exit %s", async (code) => {
  const home = await mkdtemp(join(process.env.EMEND_HOME as string, "launchd-pid-"));
  onTestFinished(() => rm(home, { recursive: true, force: true }));
  const agents = join(home, "Library/LaunchAgents");
  await mkdir(agents, { recursive: true });
  await writeFile(
    join(agents, "dev.emend.server.plist"),
    '<?xml version="1.0" encoding="UTF-8"?>\n<!-- written by emend -->\n',
  );
  await writeFile(join(home, "launchctl"), "synthetic executable", { mode: 0o700 });
  const runner = vi
    .fn<ServiceRunner>()
    .mockResolvedValue({ code, stdout: "service = {\n pid = 42\n}\n", stderr: "synthetic failure\nmore detail" });
  const stderr = vi.fn();
  const io: Io = { env: { PATH: home }, stdout: vi.fn(), stderr };
  const result = launchdServerPid({ home, tool: (name) => serviceTool(name, home, io, runner) }, 501);
  if (code === 0 || code === 113) await expect(result).resolves.toBe(code === 0 ? 42 : 0);
  else await expect(result).rejects.toThrow("launchctl print gui/501/dev.emend.server: synthetic failure");
  expect(runner).toHaveBeenCalledOnce();
  expect(stderr).not.toHaveBeenCalled();
});
