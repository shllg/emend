import { mkdir, mkdtemp, open, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { writeService } from "./common.ts";

vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open), writeFile: vi.fn(actual.writeFile), rename: vi.fn(actual.rename) };
});

test.each(["write", "sync", "rename"])(
  "a failed atomic %s leaves the previous service intact and no temporary file",
  async (step) => {
    const folder = await mkdtemp(join(process.env.RECENSE_HOME as string, "atomic-service-"));
    const path = join(folder, "recense.service");
    const previous = "# written by recense\nprevious complete service\n";
    await writeFile(path, previous);
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    const failure = Object.assign(new Error("synthetic disk failure"), { code: "ENOSPC" });
    if (step === "write") {
      vi.mocked(writeFile).mockImplementationOnce(async (file) => {
        await actual.writeFile(file, "partial");
        throw failure;
      });
      vi.mocked(open).mockImplementationOnce(async (...args) => {
        const handle = await actual.open(...args);
        const write = handle.writeFile.bind(handle);
        vi.spyOn(handle, "writeFile").mockImplementationOnce(async () => {
          await write("partial");
          throw failure;
        });
        return handle;
      });
    } else if (step === "sync") {
      vi.mocked(open).mockImplementationOnce(async (...args) => {
        const handle = await actual.open(...args);
        vi.spyOn(handle, "sync").mockRejectedValueOnce(failure);
        return handle;
      });
    } else vi.mocked(rename).mockRejectedValueOnce(failure);
    try {
      await expect(writeService(path, "# written by recense\nreplacement\n")).rejects.toBe(failure);
      expect(await readFile(path, "utf8")).toBe(previous);
      expect(await readdir(folder)).toEqual(["recense.service"]);
    } finally {
      vi.mocked(writeFile).mockReset().mockImplementation(actual.writeFile);
      vi.mocked(open).mockReset().mockImplementation(actual.open);
      vi.mocked(rename).mockReset().mockImplementation(actual.rename);
    }
  },
);

test("atomic writes exclusively create a random temporary file beside the target", async () => {
  const folder = await mkdtemp(join(process.env.RECENSE_HOME as string, "atomic-service-"));
  const path = join(folder, "units", "recense.service");
  await mkdir(join(folder, "units"));
  vi.mocked(open).mockClear();
  await writeService(path, "first");
  await writeService(path, "second");
  expect(await readFile(path, "utf8")).toBe("second");
  expect(await readdir(join(folder, "units"))).toEqual(["recense.service"]);
  const calls = vi.mocked(open).mock.calls;
  expect(calls).toHaveLength(2);
  for (const [temporary, flags] of calls) {
    expect(String(temporary).startsWith(`${path}.`)).toBe(true);
    expect(flags).toBe("wx");
  }
  expect(calls[0]?.[0]).not.toBe(calls[1]?.[0]);
});

test("atomic writes finish syncing the temporary file before closing and renaming it", async () => {
  const folder = await mkdtemp(join(process.env.RECENSE_HOME as string, "atomic-service-"));
  const path = join(folder, "recense.service");
  await writeFile(path, "previous");
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  const events: string[] = [];
  vi.mocked(open).mockImplementationOnce(async (...args) => {
    const handle = await actual.open(...args);
    const write = handle.writeFile.bind(handle);
    const sync = handle.sync.bind(handle);
    const close = handle.close.bind(handle);
    vi.spyOn(handle, "writeFile").mockImplementationOnce(async (...args) => {
      await write(...args);
      events.push("written");
    });
    vi.spyOn(handle, "sync").mockImplementationOnce(async () => {
      expect(events).toEqual(["written"]);
      expect(await readFile(path, "utf8")).toBe("previous");
      await sync();
      events.push("synced");
    });
    vi.spyOn(handle, "close").mockImplementationOnce(async () => {
      events.push("closed");
      await close();
    });
    return handle;
  });
  vi.mocked(rename).mockImplementationOnce(async (...args) => {
    events.push("renamed");
    await actual.rename(...args);
  });
  try {
    await writeService(path, "replacement");
    expect(events).toEqual(["written", "synced", "closed", "renamed"]);
    expect(await readFile(path, "utf8")).toBe("replacement");
    expect(await readdir(folder)).toEqual(["recense.service"]);
  } finally {
    vi.mocked(open).mockReset().mockImplementation(actual.open);
    vi.mocked(rename).mockReset().mockImplementation(actual.rename);
  }
});
