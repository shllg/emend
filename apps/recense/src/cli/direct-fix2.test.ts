import { execFile } from "node:child_process";
import { closeSync, constants, openSync, writeFileSync } from "node:fs";
import { symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { LIMITS } from "@recense/contract";
import { expect, test, vi } from "vitest";
import * as client from "../db/client.ts";
import { initializeServerState } from "../server/state.ts";
import { StateFolderWriteError } from "../state/files.ts";
import { directFixture } from "./direct-test-support.ts";

vi.mock("../db/client.ts", async (original) => ({ ...(await original<typeof import("../db/client.ts")>()) }));

test.each(["symlink", "oversized"])("direct publish ignores a %s server-url.json", async (kind) => {
  const f = await directFixture();
  const path = join(f.stateDir, "server-url.json");
  const record = JSON.stringify({ baseUrl: "https://review.example" });
  if (kind === "symlink") {
    const target = join(f.dir, "origin.json");
    await writeFile(target, record);
    await symlink(target, path);
  } else await writeFile(path, record + " ".repeat(LIMITS.publicJsonBytes));
  const { result } = await f.publish();
  expect(result.url).toBe(`http://127.0.0.1:3636/r/${result.reviewId}`);
});

test.skipIf(process.platform === "win32")("direct publish ignores a FIFO server-url.json", async () => {
  const f = await directFixture();
  const path = join(f.stateDir, "server-url.json");
  await promisify(execFile)("mkfifo", [path], { env: { PATH: process.env.PATH, LC_ALL: "C" } });
  // Release an unsafe blocking reader with valid JSON, so the red test fails on
  // the origin instead of leaving a filesystem read hanging after test timeout.
  const writer = setInterval(() => {
    const fd = openSync(path, constants.O_RDWR | constants.O_NONBLOCK);
    try {
      writeFileSync(fd, JSON.stringify({ baseUrl: "https://review.example" }));
    } finally {
      closeSync(fd);
    }
  }, 20);
  try {
    const { result } = await f.publish();
    expect(result.url).toBe(`http://127.0.0.1:3636/r/${result.reviewId}`);
  } finally {
    clearInterval(writer);
  }
});

test.each(["EACCES", "EPERM", "EROFS", "ENOENT"])(
  "bootstrap preserves %s errors whose path is unrelated to its state folder",
  async (code) => {
    const f = await directFixture();
    const error = Object.assign(new Error("synthetic unrelated failure"), {
      code,
      path: join(f.dir, "state-other", "worker.mjs"),
    });
    vi.spyOn(client, "openDb").mockImplementation(() => {
      throw error;
    });
    await expect(initializeServerState(f.stateDir)).rejects.toBe(error);
  },
);

test.each(["folder", "ancestor", "child"])("bootstrap maps an error at its state %s", async (location) => {
  const f = await directFixture();
  const path =
    location === "folder" ? f.stateDir : location === "ancestor" ? dirname(f.stateDir) : join(f.stateDir, "recense.db");
  vi.spyOn(client, "openDb").mockImplementation(() => {
    throw Object.assign(new Error("synthetic state failure"), { code: "EACCES", path });
  });
  await expect(initializeServerState(f.stateDir)).rejects.toEqual(new StateFolderWriteError(f.stateDir));
});

test.each([{ code: "EPERM" }, { code: "EIO", path: "state" }])(
  "bootstrap preserves an error without both a mapped code and a related path: %j",
  async (properties) => {
    const f = await directFixture();
    const error = Object.assign(
      new Error("synthetic other failure"),
      properties,
      properties.path ? { path: f.stateDir } : {},
    );
    vi.spyOn(client, "openDb").mockImplementation(() => {
      throw error;
    });
    await expect(initializeServerState(f.stateDir)).rejects.toBe(error);
  },
);
