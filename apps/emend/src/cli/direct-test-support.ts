import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PublishResponse } from "@emend/contract";
import { onTestFinished, vi } from "vitest";
import { devices, owners } from "../db/schema.ts";
import type { Io } from "../main.ts";
import { createApp } from "../server/app.ts";
import { createToken, SESSION_MS } from "../server/auth/tokens.ts";
import { initializeServerState, serverConfig } from "../server/serve.ts";
import { publishCommand } from "./commands/publish.ts";
import * as roots from "./publish/root.ts";

export async function directFixture() {
  vi.spyOn(roots, "worktreeRoot").mockResolvedValue(null);
  const dir = await realpath(await mkdtemp(join(tmpdir(), "emend-direct-")));
  const stateDir = join(dir, "state");
  const configHome = join(dir, "config");
  const configDir = join(configHome, "emend");
  const source = join(dir, "source");
  await mkdir(source);
  await mkdir(stateDir, { mode: 0o700 });
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  await writeFile(join(configDir, "config.json"), JSON.stringify({ docRoots: [source] }), {
    mode: 0o600,
  });
  const manifest = join(source, "review.json");
  await writeFile(join(source, "plan.md"), "# Synthetic plan\n\nReview this plan.\n");
  await writeFile(
    manifest,
    JSON.stringify({
      version: 1,
      title: "Synthetic direct review",
      topics: [],
      files: [{ path: "plan.md", role: "doc" }],
      writeup: { overview: "Synthetic overview", tldr: "Review", decisions: null, topics: {} },
    }),
  );
  const cleanup: (() => Promise<unknown>)[] = [];
  onTestFinished(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    for (const close of cleanup.reverse()) await close();
    await rm(dir, { recursive: true, force: true });
  });
  function output() {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const io: Io = {
      stdout: (line) => {
        stdout.push(line);
      },
      stdoutAsync: async (line) => {
        stdout.push(line);
      },
      stderr: (line) => {
        stderr.push(line);
      },
      env: { EMEND_HOME: stateDir, XDG_CONFIG_HOME: configHome },
    };
    return { io, stdout, stderr };
  }
  async function publish(key = "synthetic") {
    const out = output();
    await publishCommand(stateDir, configDir, ["--manifest", manifest, "--key", key], out.io, source);
    return { ...out, result: PublishResponse.parse(JSON.parse(out.stdout.join(""))) };
  }
  async function reviewer() {
    const state = await initializeServerState(stateDir);
    cleanup.push(() => state.db.close());
    const owner = await state.db.read((q) => q.select().from(owners).get());
    if (!owner) throw new Error("missing test owner");
    const device = await state.db.query((q) =>
      q.insert(devices).values({ ownerId: owner.id, kind: "browser", name: "Synthetic" }).returning().get(),
    );
    const session = await createToken(state.db, owner.id, "reviewer", {
      deviceId: device?.id,
      expiresAt: Date.now() + SESSION_MS,
    });
    const origin = "http://127.0.0.1:3636";
    const app = createApp({ ...state, now: Date.now, config: serverConfig("127.0.0.1", 3636, dir) });
    const headers = (url = origin) => ({
      Host: new URL(url).host,
      Origin: url,
      Cookie: `emend_session=${session.secret}`,
      "Content-Type": "application/json",
    });
    const request = (path: string, body?: unknown) =>
      app.request(`${origin}/api/v1${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: headers(),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    return { ...state, ownerId: owner.id, app, request, headers };
  }
  return { dir, stateDir, configDir, source, manifest, output, publish, reviewer, cleanup };
}
