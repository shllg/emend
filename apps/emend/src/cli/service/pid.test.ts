import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, expect, onTestFinished, test, vi } from "vitest";
import type { Io } from "../../main.ts";
import { servicePid } from "./pid.ts";

vi.mock("node:fs/promises", async (original) => ({
  ...(await original<typeof import("node:fs/promises")>()),
}));
afterEach(() => vi.restoreAllMocks());

for (const platform of ["linux", "darwin"]) {
  test.each(["foreign", "directory", "symlink", "unreadable"])(
    `${platform} service ownership distinguishes a %s file before any query`,
    async (kind) => {
      const home = await mkdtemp(join(process.env.EMEND_HOME as string, "service-pid-"));
      onTestFinished(() => rm(home, { recursive: true, force: true }));
      const path = join(
        home,
        platform === "linux" ? ".config/systemd/user/emend.service" : "Library/LaunchAgents/dev.emend.server.plist",
      );
      const prefix =
        platform === "linux"
          ? "# written by emend\n"
          : '<?xml version="1.0" encoding="UTF-8"?>\n<!-- written by emend -->\n';
      await mkdir(dirname(path), { recursive: true });
      if (kind === "directory") await mkdir(path);
      else if (kind === "symlink") {
        const target = join(home, "target");
        await writeFile(target, prefix);
        await symlink(target, path);
      } else await writeFile(path, kind === "foreign" ? "another program\n" : prefix);
      if (kind === "unreadable") {
        const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
        vi.spyOn(await import("node:fs/promises"), "readFile").mockImplementation(async (...args) => {
          if (args[0] === path) throw Object.assign(new Error("synthetic denial"), { code: "EACCES", path });
          return actual.readFile(...args);
        });
      }
      const runner = vi.fn();
      const io: Io = {
        env: { PATH: "" },
        stdout: vi.fn(),
        stderr: vi.fn(),
        service: { platform, home, uid: 501, runner },
      };
      expect(await servicePid(io)).toBe(kind === "unreadable" ? null : 0);
      if (kind === "unreadable") expect(readFile).toHaveBeenCalledWith(path, "utf8");
      expect(runner).not.toHaveBeenCalled();
      expect(io.stderr).not.toHaveBeenCalled();
    },
  );
}
