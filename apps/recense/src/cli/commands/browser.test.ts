import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { findExecutable } from "../executable.ts";
import { openBrowser } from "./open.ts";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
vi.mock("../executable.ts", () => ({ findExecutable: vi.fn() }));
const url = `http://127.0.0.1:3636/pair#emp_${"a".repeat(43)}`;
let child: ReturnType<typeof spawn>;
beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(process, "platform", "get").mockReturnValue("linux");
  vi.mocked(findExecutable)
    .mockReset()
    .mockImplementation(async (name) => ({ file: `/synthetic/bin/${name}`, path: "/synthetic/bin" }));
  child = Object.assign(new EventEmitter(), { unref: vi.fn() }) as unknown as ReturnType<typeof spawn>;
  vi.mocked(spawn).mockReset().mockReturnValue(child);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

test.each([{}, { DISPLAY: "" }, { WAYLAND_DISPLAY: "" }, { DISPLAY: "", WAYLAND_DISPLAY: "" }])(
  "Linux without a graphical session does not spawn an opener: %j",
  async (env) => {
    expect(await openBrowser(url, env)).toBe(false);
    expect(findExecutable).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  },
);

test.each([{ DISPLAY: ":0" }, { WAYLAND_DISPLAY: "wayland-0" }])(
  "Linux waits for a successful exit with a graphical session: %j",
  async (env) => {
    const settled = vi.fn();
    const opened = openBrowser(url, env);
    void opened.then(settled);
    await vi.advanceTimersByTimeAsync(0);
    expect(spawn).toHaveBeenCalledWith("/synthetic/bin/xdg-open", [url], {
      detached: true,
      stdio: "ignore",
      cwd: "/",
      env: { ...env, PATH: "/synthetic/bin" },
    });
    child.emit("spawn");
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    expect(child.unref).not.toHaveBeenCalled();
    child.emit("exit", 0, null);
    expect(await opened).toBe(true);
    expect(child.unref).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  },
);

test.each([3, null])("browser opener exit code %s offers the link", async (code) => {
  const opened = openBrowser(url, { DISPLAY: ":0" });
  await vi.advanceTimersByTimeAsync(0);
  child.emit("exit", code, code === null ? "SIGTERM" : null);
  expect(await opened).toBe(false);
  expect(child.unref).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

test("browser opener spawn error ENOENT offers the link", async () => {
  const opened = openBrowser(url, { DISPLAY: ":0" });
  await vi.advanceTimersByTimeAsync(0);
  child.emit("error", Object.assign(new Error("missing opener"), { code: "ENOENT" }));
  expect(await opened).toBe(false);
  expect(child.unref).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

test("a synchronous spawn failure offers the link", async () => {
  vi.mocked(spawn).mockImplementationOnce(() => {
    throw new Error("opener failed");
  });
  expect(await openBrowser(url, { DISPLAY: ":0" })).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
});

test.each([undefined, 10])("a running opener succeeds and unrefs after timeout %s", async (timeoutMs) => {
  const settled = vi.fn();
  const opened = openBrowser(url, { DISPLAY: ":0" }, timeoutMs);
  void opened.then(settled);
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync((timeoutMs ?? 5_000) - 1);
  expect(settled).not.toHaveBeenCalled();
  expect(child.unref).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(await opened).toBe(true);
  expect(child.unref).toHaveBeenCalledOnce();
  child.emit("exit", 3, null);
  expect(child.unref).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

test("macOS skips the graphical session check", async () => {
  vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
  const opened = openBrowser(url, {});
  await vi.advanceTimersByTimeAsync(0);
  expect(spawn).toHaveBeenCalledWith("/synthetic/bin/open", [url], {
    detached: true,
    stdio: "ignore",
    cwd: "/",
    env: { PATH: "/synthetic/bin" },
  });
  child.emit("exit", 0, null);
  expect(await opened).toBe(true);
  expect(child.unref).toHaveBeenCalledOnce();
});

test("a missing executable returns false without spawning", async () => {
  vi.mocked(findExecutable).mockRejectedValueOnce(new Error("not on PATH"));
  expect(await openBrowser(url, { DISPLAY: ":0", PATH: "relative" })).toBe(false);
  expect(findExecutable).toHaveBeenCalledWith("xdg-open", "relative");
  expect(spawn).not.toHaveBeenCalled();
});

test("unsupported platforms return false without resolving or spawning", async () => {
  vi.spyOn(process, "platform", "get").mockReturnValue("freebsd");
  expect(await openBrowser(url, {})).toBe(false);
  expect(findExecutable).not.toHaveBeenCalled();
  expect(spawn).not.toHaveBeenCalled();
});
