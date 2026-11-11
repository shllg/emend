import { createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onTestFinished, vi } from "vitest";
import type { Io } from "../main.ts";
import { writeSecretFile } from "../state/files.ts";

export function provenTestServer(stateDir: string): (url: string | URL, init?: RequestInit) => Response | undefined {
  const key = Buffer.alloc(32, 3).toString("base64url");
  writeSecretFile(
    join(stateDir, "server.json"),
    JSON.stringify({ url: "http://127.0.0.1:3636", pid: process.pid, key }),
  );
  return (url: string | URL, init?: RequestInit) => {
    if (!String(url).endsWith("/api/v1/capabilities")) return undefined;
    const challenge = new Headers(init?.headers).get("X-Emend-Challenge") ?? "";
    return Response.json(
      { api: 1, version: "0.1.0", features: [] },
      {
        headers: {
          "X-Emend-Proof": createHmac("sha256", Buffer.from(key, "base64url")).update(challenge).digest("base64url"),
        },
      },
    );
  };
}

export async function commandFixture() {
  const dir = await mkdtemp(join(tmpdir(), "emend-handoff-"));
  const configHome = await mkdtemp(join(tmpdir(), "emend-config-"));
  const configDir = join(configHome, "emend");
  onTestFinished(async () => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
    await rm(configHome, { recursive: true, force: true });
  });
  writeSecretFile(join(dir, "agent.token"), `em_${"a".repeat(43)}`);
  const proof = provenTestServer(dir);
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
    env: { EMEND_HOME: dir, XDG_CONFIG_HOME: configHome },
  };
  const f = {
    dir,
    configDir,
    io,
    stdout,
    stderr,
    respond: async (_url: string | URL, _init?: RequestInit): Promise<Response> => Response.json({}),
  };
  const fetcher = vi.fn(async (url: string | URL, init?: RequestInit) => proof(url, init) ?? f.respond(url, init));
  vi.stubGlobal("fetch", fetcher);
  return {
    ...f,
    fetcher,
    setResponse: (respond: typeof f.respond) => {
      f.respond = respond;
    },
  };
}
