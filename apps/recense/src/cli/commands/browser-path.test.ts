import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, relative } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { openBrowser } from "./open.ts";

afterEach(() => vi.restoreAllMocks());

test.each(["linux", "darwin"] as const)(
  "%s opener ignores a relative PATH executable and runs from / with a filtered PATH",
  async (platform) => {
    const dir = await mkdtemp(join(tmpdir(), "recense-browser-path-"));
    try {
      vi.spyOn(process, "platform", "get").mockReturnValue(platform);
      const name = platform === "darwin" ? "open" : "xdg-open";
      const untrusted = join(dir, "untrusted");
      const trusted = join(dir, "trusted");
      await mkdir(untrusted);
      await mkdir(trusted);
      await writeFile(join(untrusted, name), '#!/bin/sh\nprintf "%s\\n" "$1" > "$RECENSE_TEST_UNTRUSTED_MARKER"\n', {
        mode: 0o700,
      });
      await writeFile(
        join(trusted, name),
        '#!/bin/sh\nprintf "%s\\n" "$1" "$PWD" "$PATH" "$DISPLAY" "$WAYLAND_DISPLAY" "$XDG_RUNTIME_DIR" "$DBUS_SESSION_BUS_ADDRESS" > "$RECENSE_TEST_TRUSTED_MARKER"\n',
        { mode: 0o700 },
      );
      const env = {
        PATH: [relative(process.cwd(), untrusted), "", trusted].join(delimiter),
        DISPLAY: ":0",
        WAYLAND_DISPLAY: "wayland-0",
        XDG_RUNTIME_DIR: join(dir, "runtime"),
        DBUS_SESSION_BUS_ADDRESS: `unix:path=${join(dir, "bus")}`,
        RECENSE_TEST_TRUSTED_MARKER: join(dir, "trusted-call"),
        RECENSE_TEST_UNTRUSTED_MARKER: join(dir, "untrusted-call"),
      };
      const url = "http://127.0.0.1:3636/pair#synthetic-link";
      expect(await openBrowser(url, env)).toBe(true);
      expect(await readFile(env.RECENSE_TEST_TRUSTED_MARKER, "utf8")).toBe(
        [
          url,
          "/",
          trusted,
          env.DISPLAY,
          env.WAYLAND_DISPLAY,
          env.XDG_RUNTIME_DIR,
          env.DBUS_SESSION_BUS_ADDRESS,
          "",
        ].join("\n"),
      );
      await expect(access(env.RECENSE_TEST_UNTRUSTED_MARKER)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await openBrowser(url, { ...env, PATH: relative(process.cwd(), untrusted) })).toBe(false);
      await expect(access(env.RECENSE_TEST_UNTRUSTED_MARKER)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);
