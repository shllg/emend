import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import { chmod, mkdir, readdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { LIMITS } from "@emend/contract";
import { expect, test, vi } from "vitest";
import { run } from "../main.ts";
import * as stateFiles from "../state/files.ts";
import { writeSecretFile } from "../state/files.ts";
import * as tokens from "../state/token-file.ts";
import { cleanupAttachment, removeAttachment } from "./attach/files.ts";
import { lockAttach } from "./attach/lock.ts";
import { directFixture } from "./direct-test-support.ts";
import { escapeReference } from "./escape.ts";
import { errorLine } from "./http.ts";
import * as reader from "./publish/read.ts";

vi.mock("node:fs/promises", async (original) => ({ ...(await original<typeof import("node:fs/promises")>()) }));

const previousHub = "https://previous.example.test";
const nextHub = "https://next.example.test";
const oldToken = `em_${"o".repeat(43)}`;
const newToken = `em_${"n".repeat(43)}`;
const link = `${nextHub}/pair#emp_${"s".repeat(43)}`;
const revoked = `emend: removed an unfinished attachment to ${previousHub}; the hub revoked this machine.\n`;
const unreachable = `emend: removed an unfinished attachment to ${previousHub}. The hub did not confirm the revocation; revoke this machine in its devices.\n`;
const unfinished = `emend: an earlier attach to ${previousHub} did not finish. If the hub lists this machine, revoke it in its devices.\n`;
const stray = "emend: removed a leftover hub token. If a hub lists this machine, revoke it in its devices.\n";
const attached = "emend: attached to Synthetic hub; copied 0 reviews, skipped 0.\n";

async function fixture() {
  const f = await directFixture();
  const pending = join(f.stateDir, "attach.pending");
  const tokenPath = join(f.stateDir, "hub.token");
  const attachment = join(f.stateDir, "attach.json");
  const calls: { url: string; init: RequestInit }[] = [];
  const handler = vi.fn(async (url: string, init: RequestInit): Promise<Response> => {
    if (init.method === "DELETE") return new Response(null, { status: 204 });
    if (url.endsWith("/capabilities")) return Response.json({ api: 1, version: "0.1.0", features: ["attach"] });
    if (url.endsWith("/machines"))
      return Response.json(
        { token: newToken, hub: { id: randomUUID(), name: "Synthetic hub", url: nextHub } },
        { status: 201 },
      );
    throw new Error("Unexpected request");
  });
  vi.stubGlobal("fetch", async (url: string | URL, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init);
  });
  const command = async (name: string) => {
    const out = f.output();
    const code = await run(name === "attach" ? [name, link] : [name], out.io);
    const text = out.stderr.join("");
    expect(out.stdout).toEqual([]);
    expect(text).not.toContain(oldToken);
    expect(text).not.toContain(newToken);
    return { code, text };
  };
  const leftover = (withToken = true) => {
    writeSecretFile(pending, JSON.stringify({ hubUrl: previousHub }));
    if (withToken) writeSecretFile(tokenPath, oldToken);
  };
  const absent = async (...paths: string[]) => {
    for (const path of paths) await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
  };
  return { ...f, pending, tokenPath, attachment, calls, handler, command, leftover, absent };
}

test.each(
  ["attach", "detach"].flatMap((command) =>
    [0o004, 0o040, 0o044].flatMap((mode) => [false, true].map((completed) => ({ command, mode, completed }))),
  ),
)(
  "$command refuses hub.token mode $mode without deleting state (completed=$completed)",
  async ({ command, mode, completed }) => {
    const f = await fixture();
    f.leftover();
    if (completed)
      writeSecretFile(
        f.attachment,
        JSON.stringify({ hubUrl: previousHub, hubId: randomUUID(), hubName: "Synthetic hub" }),
      );
    const names = await readdir(f.stateDir);
    const contents = await Promise.all(names.map((name) => readFile(join(f.stateDir, name))));
    await chmod(f.tokenPath, mode);
    try {
      expect(await f.command(command)).toEqual({
        code: 1,
        text: `Token file ${f.tokenPath} has group or other permissions; fix it with chmod 600 '${f.tokenPath}'\n`,
      });
      expect(f.calls).toEqual([]);
      expect(await readdir(f.stateDir)).toEqual(names);
      expect((await stat(f.tokenPath)).mode & 0o777).toBe(mode);
    } finally {
      await chmod(f.tokenPath, 0o600).catch(() => {});
    }
    expect(await Promise.all(names.map((name) => readFile(join(f.stateDir, name))))).toEqual(contents);
  },
);

test.each(["cleanup", "cleanup completed", "attach", "detach", "publish"])(
  "%s refuses a loose hub token without changing state",
  async (command) => {
    const f = await fixture();
    f.leftover();
    if (command === "cleanup completed" || command === "detach" || command === "publish") {
      writeSecretFile(
        f.attachment,
        JSON.stringify({ hubUrl: previousHub, hubId: randomUUID(), hubName: "Synthetic hub" }),
      );
    }
    await chmod(f.tokenPath, 0o644);
    const names = await readdir(f.stateDir);
    const contents = await Promise.all(names.map((name) => readFile(join(f.stateDir, name))));
    const line = `Token file ${f.tokenPath} has group or other permissions; fix it with chmod 600 '${f.tokenPath}'\n`;
    const out = f.output();
    if (command.startsWith("cleanup")) {
      const error = await cleanupAttachment(f.stateDir, out.io).then(
        () => null,
        (error: unknown) => error,
      );
      expect(errorLine(error)).toBe(line);
      expect(out.stderr).toEqual([]);
    } else if (command === "publish") {
      vi.spyOn(process, "cwd").mockReturnValue(f.source);
      expect(await run(["publish", "--manifest", f.manifest, "--key", "synthetic"], out.io)).toBe(1);
      expect(out.stderr).toEqual([line]);
    } else {
      expect(await run(command === "attach" ? [command, link] : [command], out.io)).toBe(1);
      expect(out.stderr).toEqual([line]);
    }
    expect(out.stdout).toEqual([]);
    expect(f.calls).toEqual([]);
    expect(await readdir(f.stateDir)).toEqual(names);
    expect(await Promise.all(names.map((name) => readFile(join(f.stateDir, name))))).toEqual(contents);
    expect((await stat(f.tokenPath)).mode & 0o777).toBe(0o644);
  },
);

test("detach preserves an attachment when its token becomes loose after the preflight", async () => {
  const f = await fixture();
  const attachment = JSON.stringify({ hubUrl: previousHub, hubId: randomUUID(), hubName: "Synthetic hub" });
  writeSecretFile(f.attachment, attachment);
  writeSecretFile(f.tokenPath, oldToken);
  lockAttach(f.stateDir)();
  const before = await readdir(f.stateDir);
  const read = tokens.readTokenFile;
  vi.spyOn(tokens, "readTokenFile").mockImplementationOnce(async (...args) => {
    await chmod(f.tokenPath, 0o644);
    return read(...args);
  });
  expect(await f.command("detach")).toEqual({
    code: 1,
    text: `Token file ${f.tokenPath} has group or other permissions; fix it with chmod 600 '${f.tokenPath}'\n`,
  });
  expect(f.calls).toEqual([]);
  expect(await readdir(f.stateDir)).toEqual(before);
  expect(await readFile(f.attachment, "utf8")).toBe(attachment);
  expect(await readFile(f.tokenPath, "utf8")).toBe(oldToken);
});

test.each(["detach", "attach"])(
  "%s revokes a crash token only at its recorded hub, before continuing",
  async (command) => {
    const f = await fixture();
    f.leftover();
    const normal = f.handler.getMockImplementation();
    if (!normal) throw new Error("Missing handler");
    f.handler.mockImplementation(async (url, init) => {
      expect(() => lockAttach(f.stateDir)).toThrow("another emend attach is running.");
      return normal(url, init);
    });
    expect(await f.command(command)).toEqual({ code: 0, text: revoked + (command === "attach" ? attached : "") });
    expect(f.calls.map((call) => call.url)).toEqual([
      `${previousHub}/api/v1/machines/self`,
      ...(command === "attach" ? [`${nextHub}/api/v1/capabilities`, `${nextHub}/api/v1/machines`] : []),
    ]);
    expect(f.calls[0]?.init.method).toBe("DELETE");
    expect(new Headers(f.calls[0]?.init.headers).get("Authorization")).toBe(`Bearer ${oldToken}`);
    expect(new Headers(f.calls[0]?.init.headers).get("X-Emend-Client")).toBe("cli/0.1.0");
    expect(f.calls.every((call) => call.init.redirect === "error")).toBe(true);
    for (const call of f.calls.slice(1)) expect(new Headers(call.init.headers).has("Authorization")).toBe(false);
    await f.absent(f.pending);
    if (command === "detach") await f.absent(f.tokenPath, f.attachment);
    else {
      expect(await readFile(f.tokenPath, "utf8")).toBe(newToken);
      expect(JSON.parse(await readFile(f.attachment, "utf8")).hubUrl).toBe(nextHub);
    }
    lockAttach(f.stateDir)();
  },
);

test.each([200, 201, 202, 204, 299, 301, 401, 426, 500])(
  "recovery classifies HTTP %i by status alone",
  async (status) => {
    const f = await fixture();
    f.leftover();
    f.handler.mockResolvedValue(
      new Response(null, { status, headers: { Location: "https://elsewhere.example.test" } }),
    );
    expect(await f.command("detach")).toEqual({ code: 0, text: status < 300 ? revoked : unreachable });
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]?.init.redirect).toBe("error");
    await f.absent(f.pending, f.tokenPath, f.attachment);
  },
);

test.each(["detach", "attach"])(
  "%s removes an unfinished attachment when the recorded hub is down",
  async (command) => {
    const f = await fixture();
    f.leftover();
    f.handler.mockRejectedValueOnce(new TypeError("Synthetic refused connection", { cause: { code: "ECONNREFUSED" } }));
    expect(await f.command(command)).toEqual({ code: 0, text: unreachable + (command === "attach" ? attached : "") });
    await f.absent(f.pending);
    if (command === "detach") await f.absent(f.tokenPath, f.attachment);
  },
);

test("recovery bounds its DELETE by five seconds and cleans up after timeout", async () => {
  const f = await fixture();
  f.leftover();
  const controller = new AbortController();
  const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
  f.handler.mockImplementation(async (_url, init) => {
    controller.abort(new DOMException("Synthetic timeout", "TimeoutError"));
    init.signal?.throwIfAborted();
    throw new Error("Missing timeout");
  });
  expect(await f.command("detach")).toEqual({ code: 0, text: unreachable });
  expect(timeout).toHaveBeenCalledExactlyOnceWith(5000);
  await f.absent(f.pending, f.tokenPath);
});

test.each(["detach", "attach"])("%s cleans up a crash before the token was saved", async (command) => {
  const f = await fixture();
  f.leftover(false);
  expect(await f.command(command)).toEqual({ code: 0, text: unfinished + (command === "attach" ? attached : "") });
  expect(f.calls.some((call) => call.init.method === "DELETE")).toBe(false);
  await f.absent(f.pending);
  if (command === "detach") await f.absent(f.tokenPath, f.attachment);
});

const invalidMarkers = [
  "absent",
  "directory",
  "symlink",
  "{",
  "null",
  "[]",
  "{}",
  '{"hubUrl":42}',
  ...[
    "http://hub.example.test",
    "https://user:pass@hub.example.test",
    "https://hub.example.test/path",
    "https://hub.example.test?x",
    "https://hub.example.test#x",
    "//hub.example.test",
    "file:///tmp/hub",
    "https://hub.example.test/../",
    "https://hub.example.test\\path",
    "https://hub.example.test\n",
  ].map((hubUrl) => JSON.stringify({ hubUrl })),
  "oversized",
];
test.each(["detach", "attach"].flatMap((command) => invalidMarkers.map((marker) => [command, marker])))(
  "%s never sends a stray token with marker %s",
  async (command, marker) => {
    const f = await fixture();
    writeSecretFile(f.tokenPath, oldToken);
    if (marker === "directory") await mkdir(f.pending);
    else if (marker === "symlink") {
      const outside = join(f.dir, "synthetic-marker.json");
      await writeFile(outside, JSON.stringify({ hubUrl: previousHub }));
      await symlink(outside, f.pending);
    } else if (marker !== "absent")
      await writeFile(f.pending, marker === "oversized" ? " ".repeat(LIMITS.publicJsonBytes + 1) : (marker ?? ""));
    expect(await f.command(command ?? "")).toEqual({ code: 0, text: stray + (command === "attach" ? attached : "") });
    expect(f.calls.some((call) => call.init.method === "DELETE")).toBe(false);
    expect(f.calls.every((call) => !new Headers(call.init.headers).has("Authorization"))).toBe(true);
    await f.absent(f.pending);
    if (command === "detach") await f.absent(f.tokenPath, f.attachment);
  },
);

test.skipIf(process.getuid?.() === 0).each(["detach", "attach"])(
  "%s preserves an unreadable marker and its token with the state-folder error",
  async (command) => {
    const f = await fixture();
    f.leftover();
    await chmod(f.pending, 0o000);
    try {
      expect(await f.command(command)).toEqual({
        code: 1,
        text: `emend cannot write its state folder ${escapeReference(f.stateDir)}.\n`,
      });
      expect(f.calls).toEqual([]);
      expect(existsSync(f.pending)).toBe(true);
      expect(await readFile(f.tokenPath, "utf8")).toBe(oldToken);
    } finally {
      await chmod(f.pending, 0o600);
    }
  },
);

test.each(["detach", "attach"])("%s only discards the marker of a completed attachment", async (command) => {
  const f = await fixture();
  expect(await f.command("attach")).toEqual({ code: 0, text: attached });
  const saved = await readFile(f.attachment);
  f.leftover(false);
  f.calls.length = 0;
  expect(await f.command(command)).toEqual({
    code: 0,
    text: command === "attach" ? attached : "emend: detached from Synthetic hub.\n",
  });
  expect(f.calls.every((call) => call.url.startsWith(nextHub))).toBe(true);
  await f.absent(f.pending);
  if (command === "attach") {
    expect(await readFile(f.attachment)).toEqual(saved);
    expect(await readFile(f.tokenPath, "utf8")).toBe(newToken);
    expect(f.calls).toHaveLength(1);
  } else await f.absent(f.attachment, f.tokenPath);
});

test("registration saves a private origin marker before requesting a token and removes it on success", async () => {
  const f = await fixture();
  const normal = f.handler.getMockImplementation();
  if (!normal) throw new Error("Missing handler");
  const markers: unknown[] = [];
  const modes: number[] = [];
  f.handler.mockImplementation(async (url, init) => {
    if (url.endsWith("/machines")) {
      markers.push(JSON.parse(await readFile(f.pending, "utf8")));
      modes.push((await stat(f.pending)).mode & 0o777);
    }
    return normal(url, init);
  });
  expect(await f.command("attach")).toEqual({ code: 0, text: attached });
  expect(markers).toEqual([{ hubUrl: nextHub }]);
  expect(modes).toEqual([0o600]);
  await f.absent(f.pending);
});

test("a failed pending-marker write sends no registration and reports the existing save error", async () => {
  const f = await fixture();
  const write = stateFiles.writeSecretFile;
  vi.spyOn(stateFiles, "writeSecretFile").mockImplementation((path, ...args) => {
    if (path === f.pending) throw new Error("Synthetic marker write failure");
    return write(path, ...args);
  });
  expect(await f.command("attach")).toEqual({ code: 1, text: "emend: could not save the attachment.\n" });
  expect(f.calls.map((call) => call.url)).toEqual([`${nextHub}/api/v1/capabilities`]);
  await f.absent(f.pending, f.tokenPath, f.attachment);
});

test.each(["api", "json", "schema", "unanswered", "mismatch", "save", "SIGINT", "SIGTERM", "SIGHUP"])(
  "registration %s prints its guidance before removing the marker",
  async (failure) => {
    const f = await fixture();
    const normal = f.handler.getMockImplementation();
    if (!normal) throw new Error("Missing handler");
    f.handler.mockImplementation(async (url, init) => {
      if (!url.endsWith("/machines")) return normal(url, init);
      if (failure === "api")
        return Response.json({ error: { code: "unauthorized", message: "Synthetic refusal." } }, { status: 401 });
      if (failure === "json") return new Response("{", { status: 201 });
      if (failure === "schema") return Response.json({}, { status: 201 });
      if (failure === "unanswered") throw new TypeError("Synthetic lost answer");
      if (failure === "mismatch")
        return Response.json(
          { token: newToken, hub: { id: randomUUID(), name: "Synthetic hub", url: previousHub } },
          { status: 201 },
        );
      if (failure === "save") await mkdir(f.attachment);
      if (failure.startsWith("SIG")) {
        process.emit(failure);
        init.signal?.throwIfAborted();
      }
      return normal(url, init);
    });
    const out = f.output();
    const markerAtGuidance: boolean[] = [];
    const stderr = out.io.stderr;
    out.io.stderr = (line) => {
      markerAtGuidance.push(existsSync(f.pending));
      stderr(line);
    };
    expect(await run(["attach", link], out.io)).toBe(
      failure === "SIGINT" ? 130 : failure === "SIGTERM" ? 143 : failure === "SIGHUP" ? 129 : 1,
    );
    expect(markerAtGuidance).toEqual([true]);
    expect(out.stdout).toEqual([]);
    expect(out.stderr.join("")).not.toContain(newToken);
    expect(f.calls.every((call) => call.url.startsWith(nextHub))).toBe(true);
    await f.absent(f.pending, f.tokenPath, f.attachment);
  },
);

test.skipIf(process.getuid?.() === 0).each(["detach", "attach"])(
  "%s maps a state-folder permission failure during cleanup",
  async (command) => {
    const f = await fixture();
    f.leftover();
    f.handler.mockImplementation(async () => {
      await chmod(f.stateDir, 0o500);
      return new Response(null, { status: 204 });
    });
    try {
      expect(await f.command(command)).toEqual({
        code: 1,
        text: `emend cannot write its state folder ${escapeReference(f.stateDir)}.\n`,
      });
      expect(f.calls).toHaveLength(1);
      expect(existsSync(f.pending)).toBe(true);
      expect(existsSync(f.tokenPath)).toBe(true);
    } finally {
      await chmod(f.stateDir, 0o700);
    }
  },
);

test("removeAttachment also removes its pending marker", async () => {
  const f = await fixture();
  f.leftover();
  await removeAttachment(f.stateDir);
  await f.absent(f.pending, f.tokenPath, f.attachment);
});

test("an invalid marker without a token is discarded without a request", async () => {
  const f = await fixture();
  await writeFile(f.pending, "{");
  expect(await f.command("detach")).toEqual({ code: 0, text: "" });
  expect(f.calls).toEqual([]);
  await f.absent(f.pending);
  expect(await f.command("detach")).toEqual({ code: 1, text: "emend: emend is not attached.\n" });
});

function denyRemoval(path: string) {
  const remove = fs.rm;
  return vi.spyOn(fs, "rm").mockImplementation(async (value, options) => {
    if (value === path) throw Object.assign(new Error("Synthetic unlink denial"), { code: "EPERM", path });
    return remove(value, options);
  });
}

test.each(["hub.token", "attach.json"])("removeAttachment preserves the marker if removing %s fails", async (name) => {
  const f = await fixture();
  f.leftover();
  await writeFile(f.attachment, "{}");
  const denied = denyRemoval(join(f.stateDir, name));
  await expect(removeAttachment(f.stateDir)).rejects.toBeInstanceOf(stateFiles.StateFolderWriteError);
  expect(await readFile(f.pending, "utf8")).toBe(JSON.stringify({ hubUrl: previousHub }));
  expect(denied.mock.calls.some(([path]) => path === f.pending)).toBe(false);
  denied.mockRestore();
  await removeAttachment(f.stateDir);
  await f.absent(f.pending, f.tokenPath, f.attachment);
});

test.each(["detach", "attach"])(
  "%s keeps the origin and prints no cleanup line if token removal fails",
  async (command) => {
    const f = await fixture();
    f.leftover();
    f.handler.mockRejectedValueOnce(new TypeError("Synthetic connection failure"));
    const denied = denyRemoval(f.tokenPath);
    expect(await f.command(command)).toEqual({
      code: 1,
      text: `emend cannot write its state folder ${escapeReference(f.stateDir)}.\n`,
    });
    expect(await readFile(f.pending, "utf8")).toBe(JSON.stringify({ hubUrl: previousHub }));
    expect(await readFile(f.tokenPath, "utf8")).toBe(oldToken);
    expect(denied.mock.calls.some(([path]) => path === f.pending)).toBe(false);
    expect(f.calls.map((call) => call.url)).toEqual([`${previousHub}/api/v1/machines/self`]);
    denied.mockRestore();
    expect(await f.command("detach")).toEqual({ code: 0, text: revoked });
    expect(f.calls.map((call) => call.url)).toEqual(Array(2).fill(`${previousHub}/api/v1/machines/self`));
    await f.absent(f.pending, f.tokenPath, f.attachment);
  },
);

test.each(["detach", "attach"])(
  "%s keeps the marker and prints no cleanup line if attachment removal fails",
  async (command) => {
    const f = await fixture();
    f.leftover();
    await mkdir(f.attachment);
    const denied = denyRemoval(f.attachment);
    expect(await f.command(command)).toEqual({
      code: 1,
      text: `emend cannot write its state folder ${escapeReference(f.stateDir)}.\n`,
    });
    expect(await readFile(f.pending, "utf8")).toBe(JSON.stringify({ hubUrl: previousHub }));
    expect(denied.mock.calls.some(([path]) => path === f.pending)).toBe(false);
    await f.absent(f.tokenPath);
  },
);

test.each(["detach", "attach"])(
  "%s prints token guidance before failing to remove a non-empty marker folder",
  async (command) => {
    const f = await fixture();
    writeSecretFile(f.tokenPath, oldToken);
    await mkdir(f.pending);
    const child = join(f.pending, "synthetic.txt");
    await writeFile(child, "Preserve this file.");
    expect(await f.command(command)).toEqual({ code: 1, text: `${stray}emend: The emend request failed.\n` });
    expect(f.calls).toEqual([]);
    await f.absent(f.tokenPath, f.attachment);
    expect(await readFile(child, "utf8")).toBe("Preserve this file.");
  },
);

test.each(["detach", "attach"].flatMap((command) => ["directory", "symlink"].map((kind) => [command, kind])))(
  "%s recovers a leftover token next to a non-regular attachment (%s)",
  async (command, kind) => {
    const f = await fixture();
    f.leftover();
    const outside = join(f.dir, "synthetic-attachment.json");
    if (kind === "directory") await mkdir(f.attachment);
    else {
      await writeFile(outside, "{}");
      await symlink(outside, f.attachment);
    }
    expect(await f.command(command ?? "")).toEqual({ code: 0, text: revoked + (command === "attach" ? attached : "") });
    expect(f.calls[0]?.url).toBe(`${previousHub}/api/v1/machines/self`);
    await f.absent(f.pending);
    if (command === "detach") await f.absent(f.tokenPath, f.attachment);
    else expect(await readFile(f.tokenPath, "utf8")).toBe(newToken);
    if (kind === "symlink") expect(await readFile(outside, "utf8")).toBe("{}");
  },
);

test("an unexpected marker read error preserves the origin and token", async () => {
  const f = await fixture();
  f.leftover();
  const read = reader.readRegular;
  vi.spyOn(reader, "readRegular").mockImplementation(async (path, ...args) => {
    if (path === f.pending) throw Object.assign(new Error("Synthetic I/O failure"), { code: "EIO", path });
    return read(path, ...args);
  });
  expect(await f.command("detach")).toEqual({ code: 1, text: "emend: The emend request failed.\n" });
  expect(f.calls).toEqual([]);
  expect(existsSync(f.pending)).toBe(true);
  expect(await readFile(f.tokenPath, "utf8")).toBe(oldToken);
});

test.each(
  ["mismatch", "save"].flatMap((failure) =>
    [200, 204, 401, 426, "network", "timeout"].map((answer) => ({ failure, answer })),
  ),
)("$failure gives one accurate line after revocation answers $answer", async ({ failure, answer }) => {
  const f = await fixture();
  const normal = f.handler.getMockImplementation();
  if (!normal) throw new Error("Missing handler");
  const timeout = vi.spyOn(AbortSignal, "timeout");
  f.handler.mockImplementation(async (url, init) => {
    if (init.method === "DELETE") {
      if (answer === "network") throw new TypeError("Synthetic connection failure");
      if (answer === "timeout") throw new DOMException("Synthetic timeout", "TimeoutError");
      return new Response(null, { status: Number(answer) });
    }
    if (url.endsWith("/machines")) {
      if (failure === "save") await mkdir(f.attachment);
      else
        return Response.json(
          { token: newToken, hub: { id: randomUUID(), name: "Hub", url: previousHub } },
          { status: 201 },
        );
    }
    return normal(url, init);
  });
  const message =
    failure === "save" ? "could not save the attachment." : "the hub's address does not match the pairing link.";
  const confirmed = typeof answer === "number" && answer < 300;
  expect(await f.command("attach")).toEqual({
    code: 1,
    text: `emend: ${message}${confirmed ? "" : " Revoke this machine in the hub's devices."}\n`,
  });
  expect(timeout).toHaveBeenLastCalledWith(5000);
  const deleted = f.calls.filter((call) => call.init.method === "DELETE");
  expect(deleted).toHaveLength(1);
  expect(deleted[0]?.url).toBe(`${nextHub}/api/v1/machines/self`);
  expect(new Headers(deleted[0]?.init.headers).get("Authorization")).toBe(`Bearer ${newToken}`);
  expect(deleted[0]?.init.redirect).toBe("error");
  await f.absent(f.pending, f.tokenPath, f.attachment);
});

test.each(
  ["SIGINT", "SIGTERM", "SIGHUP"].flatMap((signalName) =>
    [true, false].map((confirmed) => ({ signalName, confirmed })),
  ),
)(
  "$signalName after the answer revokes independently of the signal (confirmed $confirmed)",
  async ({ signalName, confirmed }) => {
    const f = await fixture();
    const normal = f.handler.getMockImplementation();
    if (!normal) throw new Error("Missing handler");
    const timeout = vi.spyOn(AbortSignal, "timeout");
    let registrationSignal: AbortSignal | null | undefined;
    const revokedWhileAborted: boolean[] = [];
    f.handler.mockImplementation(async (url, init) => {
      if (init.method === "DELETE") {
        revokedWhileAborted.push(Boolean(init.signal?.aborted));
        return new Response(null, { status: confirmed ? 204 : 500 });
      }
      const response = await normal(url, init);
      if (url.endsWith("/machines")) {
        registrationSignal = init.signal;
        process.emit(signalName);
      }
      return response;
    });
    expect(await f.command("attach")).toEqual({
      code: signalName === "SIGINT" ? 130 : signalName === "SIGTERM" ? 143 : 129,
      text: confirmed
        ? ""
        : "emend: the hub registered this machine before emend stopped. Revoke this machine in the hub's devices.\n",
    });
    expect(registrationSignal?.aborted).toBe(true);
    expect(revokedWhileAborted).toEqual([false]);
    expect(timeout).toHaveBeenLastCalledWith(5000);
    const deleted = f.calls.filter((call) => call.init.method === "DELETE");
    expect(deleted).toHaveLength(1);
    expect(deleted[0]?.url).toBe(`${nextHub}/api/v1/machines/self`);
    expect(deleted[0]?.init.signal).not.toBe(registrationSignal);
    expect(deleted[0]?.init.redirect).toBe("error");
    expect(new Headers(deleted[0]?.init.headers).get("Authorization")).toBe(`Bearer ${newToken}`);
    await f.absent(f.pending, f.tokenPath, f.attachment);
  },
);

test.each(["mismatch", "save"].flatMap((failure) => [true, false].map((confirmed) => ({ failure, confirmed }))))(
  "a signal during $failure revocation keeps its phase guidance (confirmed $confirmed)",
  async ({ failure, confirmed }) => {
    const f = await fixture();
    const normal = f.handler.getMockImplementation();
    if (!normal) throw new Error("Missing handler");
    f.handler.mockImplementation(async (url, init) => {
      if (init.method === "DELETE") {
        process.emit("SIGTERM");
        init.signal?.throwIfAborted();
        return new Response(null, { status: confirmed ? 204 : 500 });
      }
      if (url.endsWith("/machines")) {
        if (failure === "save") await mkdir(f.attachment);
        else
          return Response.json(
            { token: newToken, hub: { id: randomUUID(), name: "Hub", url: previousHub } },
            { status: 201 },
          );
      }
      return normal(url, init);
    });
    const message =
      failure === "save" ? "could not save the attachment." : "the hub's address does not match the pairing link.";
    expect(await f.command("attach")).toEqual({
      code: 143,
      text: `emend: ${message}${confirmed ? "" : " Revoke this machine in the hub's devices."}\n`,
    });
    await f.absent(f.pending, f.tokenPath, f.attachment);
  },
);

test.each(["refusal", "save", "success"])(
  "a %s keeps its single outcome when marker removal fails",
  async (outcome) => {
    const f = await fixture();
    const normal = f.handler.getMockImplementation();
    if (!normal) throw new Error("Missing handler");
    f.handler.mockImplementation(async (url, init) => {
      if (init.method === "DELETE") throw new TypeError("Synthetic revocation failure");
      if (url.endsWith("/machines")) {
        if (outcome === "refusal")
          return Response.json({ error: { code: "unauthorized", message: "Synthetic refusal." } }, { status: 401 });
        if (outcome === "save") await mkdir(f.attachment);
      }
      return normal(url, init);
    });
    const denied = denyRemoval(f.pending);
    expect(await f.command("attach")).toEqual({
      code: outcome === "success" ? 0 : 1,
      text:
        outcome === "success"
          ? attached
          : outcome === "refusal"
            ? "emend: Synthetic refusal.\n"
            : "emend: could not save the attachment. Revoke this machine in the hub's devices.\n",
    });
    expect(await readFile(f.pending, "utf8")).toBe(JSON.stringify({ hubUrl: nextHub }));
    if (outcome === "success") {
      expect(await readFile(f.tokenPath, "utf8")).toBe(newToken);
      const saved = await readFile(f.attachment);
      denied.mockRestore();
      expect(await f.command("attach")).toEqual({ code: 0, text: attached });
      expect(await readFile(f.attachment)).toEqual(saved);
      await f.absent(f.pending);
    } else await f.absent(f.tokenPath, f.attachment);
  },
);

test("a failed save with failed revocation and token removal keeps one line and the recovery marker", async () => {
  const f = await fixture();
  const normal = f.handler.getMockImplementation();
  if (!normal) throw new Error("Missing handler");
  f.handler.mockImplementation(async (url, init) => {
    if (init.method === "DELETE") throw new TypeError("Synthetic revocation failure");
    if (url.endsWith("/machines")) await mkdir(f.attachment);
    return normal(url, init);
  });
  const denied = denyRemoval(f.tokenPath);
  expect(await f.command("attach")).toEqual({
    code: 1,
    text: "emend: could not save the attachment. Revoke this machine in the hub's devices.\n",
  });
  expect(await readFile(f.pending, "utf8")).toBe(JSON.stringify({ hubUrl: nextHub }));
  expect(await readFile(f.tokenPath, "utf8")).toBe(newToken);
  expect(denied.mock.calls.some(([path]) => path === f.pending)).toBe(false);
  denied.mockRestore();
  f.handler.mockImplementation(normal);
  expect(await f.command("detach")).toEqual({ code: 0, text: revoked.replace(previousHub, nextHub) });
  await f.absent(f.pending, f.tokenPath, f.attachment);
});
