import { access, chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, onTestFinished, test, vi } from "vitest";

// git has no env argument. Bind its executable lookup to this test's PATH in its own
// module graph; restoring mocks cannot redirect an already pending call to the host PATH.
async function gitWithPath(path: string) {
  const actual = await vi.importActual<typeof import("./executable.ts")>("./executable.ts");
  vi.doMock("./executable.ts", () => ({ findExecutable: (name: string) => actual.findExecutable(name, path) }));
  vi.resetModules();
  return (await import("./git.ts")).git;
}

test.each(["", "bin"])("git ignores the %j PATH entry", async (entry) => {
  const root = await mkdtemp(join(tmpdir(), "emend-git-path-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  try {
    const folder = join(root, entry);
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, "git"), "#!/bin/sh\nprintf executed > marker\nprintf 'git version 0.0.0\\n'\n");
    await chmod(join(folder, "git"), 0o755);
    const bin = join(root, "absolute-bin");
    await mkdir(bin);
    await writeFile(join(bin, "git"), "#!/bin/sh\nprintf 'git version 2.44.0\\n'\n", { mode: 0o700 });
    const git = await gitWithPath(`${entry}:${bin}`);
    expect((await git(root, ["--version"])).toString()).toBe("git version 2.44.0\n");
    await expect(access(join(root, "marker"))).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("missing absolute git has a fixed error", async () => {
  const git = await gitWithPath(":relative");
  await expect(git("/tmp", ["--version"])).rejects.toThrow("git was not found on PATH");
});
