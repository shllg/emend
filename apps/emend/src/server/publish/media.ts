import { extname } from "node:path";
import { type DocView, docViewOf, isRenderedHtmlDoc } from "@emend/contract";
export function mediaType(path: string): string {
  const types: Record<string, string> = {
    md: "text/markdown",
    markdown: "text/markdown",
    html: "text/html",
    htm: "text/html",
    js: "text/javascript",
    mjs: "text/javascript",
    css: "text/css",
    json: "application/json",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    svg: "image/svg+xml",
    webp: "image/webp",
    avif: "image/avif",
    ico: "image/x-icon",
    bmp: "image/bmp",
    woff: "font/woff",
    woff2: "font/woff2",
    ttf: "font/ttf",
    otf: "font/otf",
    mp4: "video/mp4",
    webm: "video/webm",
    ogg: "audio/ogg",
    mp3: "audio/mpeg",
    wav: "audio/wav",
    m4a: "audio/mp4",
  };
  const extension = extname(path).slice(1).toLowerCase();
  return Object.hasOwn(types, extension) ? (types[extension] ?? "text/plain") : "text/plain";
}

export function fileMediaType(file: { role: string; path: string; view?: DocView }): string {
  if (file.role === "diff" || (file.role === "doc" && docViewOf(file) === "source")) return "text/plain";
  if (file.role === "doc") return isRenderedHtmlDoc(file) ? "text/html" : "text/markdown";
  return mediaType(file.path);
}
