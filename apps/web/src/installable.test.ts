// @vitest-environment node

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const publicRoot = fileURLToPath(new URL("../public/", import.meta.url));
const publicFile = (name: string) => readFile(join(publicRoot, name));
test("manifest is installable and every placeholder PNG has the promised size", async () => {
  const manifest = JSON.parse((await publicFile("manifest.webmanifest")).toString());
  expect(manifest).toMatchObject({
    name: "recense",
    short_name: "recense",
    display: "standalone",
    start_url: "/",
    scope: "/",
    theme_color: "#171717",
    background_color: "#fafafa",
  });
  expect(manifest.icons).toEqual([
    { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
    { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
  ]);
  for (const [name, size] of [
    ["icon-192.png", 192],
    ["icon-512.png", 512],
    ["apple-touch-icon.png", 180],
  ] as const) {
    const bytes = await publicFile(`icons/${name}`);
    expect(bytes.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    expect(bytes.readUInt32BE(16)).toBe(size);
    expect(bytes.readUInt32BE(20)).toBe(size);
  }
  const html = await readFile(fileURLToPath(new URL("../index.html", import.meta.url)), "utf8");
  expect(html).toContain('rel="manifest" href="/manifest.webmanifest"');
  expect(html).toContain('rel="apple-touch-icon" href="/icons/apple-touch-icon.png"');
  expect(html).toContain('name="theme-color" media="(prefers-color-scheme: light)" content="#fafafb"');
  expect(html).toContain('name="theme-color" media="(prefers-color-scheme: dark)" content="#171717"');
  const head = html.split("</head>")[0] ?? "";
  expect(head).toContain('<script src="/theme-boot.js"></script>');
  expect(head).not.toMatch(/<link[^>]+rel="stylesheet"[\s\S]*theme-boot/);
  const worker = await readFile(new URL("../build/service-worker.ts", import.meta.url), "utf8");
  expect(worker).toContain('"/theme-boot.js"');
  expect(worker).toContain('"public/theme-boot.js"');
  expect((await publicFile("theme-boot.js")).byteLength).toBeLessThan(2048);
});
