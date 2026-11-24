import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, expect, test, vi } from "vitest";
import { runService } from "./common.ts";

vi.mock("node:child_process", () => ({ execFile: vi.fn() }));
beforeEach(() => vi.clearAllMocks());

test.each([false, true])(
  "the service runner uses execFile with argv and records exit status (failure=%s)",
  async (failure) => {
    const home = await mkdtemp(join(process.env.RECENSE_HOME as string, "runner-"));
    const env = { HOME: home, RECENSE_HOME: join(home, "state"), PATH: join(home, "bin") };
    vi.mocked(execFile).mockImplementation(((
      _file: string,
      _args: string[],
      _options: object,
      callback: (error: Error | null, stdout: string, stderr: string) => void,
    ) =>
      callback(
        failure ? Object.assign(new Error("failed"), { code: 7 }) : null,
        "output",
        "detail",
      )) as typeof execFile);
    const file = join(home, "bin/systemctl");
    const args = ["--user", "is-active", "recense"];
    expect(await runService(file, args, { cwd: home, env })).toEqual({
      code: failure ? 7 : 0,
      stdout: "output",
      stderr: "detail",
    });
    expect(execFile).toHaveBeenCalledWith(
      file,
      args,
      {
        cwd: home,
        env,
        encoding: "utf8",
        timeout: 10000,
        maxBuffer: 1024 * 1024,
      },
      expect.any(Function),
    );
  },
);
