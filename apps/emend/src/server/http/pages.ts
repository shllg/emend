import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import type { Context } from "hono";
import { ApiError } from "./errors.ts";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
  ".woff2": "font/woff2",
  ".json": "application/json",
  ".txt": "text/plain; charset=utf-8",
};
export async function regularFile(root: string, path: string, maxBytes = Infinity) {
  try {
    const real = await realpath(path);
    const suffix = relative(root, real);
    if (suffix === ".." || suffix.startsWith(`..${sep}`) || isAbsolute(suffix)) return null;
    const file = await open(real, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > maxBytes) return null;
      let bytes: Uint8Array<ArrayBuffer>;
      if (Number.isFinite(maxBytes)) {
        // Bound the read too: the file may grow after stat.
        const buffer = new Uint8Array(maxBytes + 1);
        let length = 0;
        while (length < buffer.length) {
          const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
          if (!bytesRead) break;
          length += bytesRead;
        }
        if (length > maxBytes) return null;
        bytes = buffer.subarray(0, length);
      } else bytes = new Uint8Array(await file.readFile());
      return {
        bytes,
        type: TYPES[extname(real).toLowerCase()] ?? "application/octet-stream",
      };
    } finally {
      await file.close();
    }
  } catch (error) {
    if (["ENOENT", "ENOTDIR", "ELOOP", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) return null;
    throw error;
  }
}
export async function appPage(c: Context, webRoot: string) {
  let path: string;
  try {
    path = decodeURIComponent(c.req.path);
  } catch {
    throw new ApiError("not_found");
  }
  if (
    path === "/api" ||
    path.startsWith("/api/") ||
    path === "/content" ||
    path.startsWith("/content/") ||
    path.includes("\\") ||
    Array.from(path).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) ||
    path.split("/").includes("..")
  )
    throw new ApiError("not_found");
  let root: string;
  try {
    root = await realpath(webRoot);
  } catch {
    throw new ApiError("not_found");
  }
  const index = await regularFile(root, resolve(root, "index.html"));
  if (!index) throw new ApiError("not_found");
  let file = path === "/" ? index : await regularFile(root, resolve(root, `.${path}`));
  if (!file && !path.startsWith("/assets/") && !extname(path.split("/").at(-1) ?? "")) file = index;
  if (!file) throw new ApiError("not_found");
  c.header("Cache-Control", path.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache");
  c.header("Content-Type", file.type);
  return c.body(file.bytes);
}
