import { type DiffImageMediaType, diffImageType, LIMITS } from "@recense/contract";
import type { GitRunner } from "../git.ts";
import { OversizedFile } from "./read.ts";
import { type ChangedPath, readGitBlob, readWorktree } from "./sides.ts";

const png = Buffer.from("89504e470d0a1a0a", "hex");
const jpeg = Buffer.from("ffd8ff", "hex");
const utf8 = new TextDecoder("utf-8", { fatal: true });

function isAvif(bytes: Buffer): boolean {
  if (bytes.length < 16 || bytes.toString("latin1", 4, 8) !== "ftyp") return false;
  let end = bytes.readUInt32BE(0);
  let payload = 8;
  if (end === 0) end = bytes.length;
  if (end === 1) {
    end = Number(bytes.readBigUInt64BE(8));
    payload = 16;
  }
  if (end > bytes.length || end < payload + 8 || (end - payload) % 4 !== 0) return false;
  for (let offset = payload; offset < end; offset += 4) {
    if (offset === payload + 4) continue; // Minor version, not a brand.
    const brand = bytes.toString("latin1", offset, offset + 4);
    if (brand === "avif" || brand === "avis") return true;
  }
  return false;
}

export function recognizesImage(type: DiffImageMediaType | undefined, bytes: Buffer): boolean {
  switch (type) {
    case "image/png":
      return bytes.subarray(0, png.length).equals(png);
    case "image/jpeg":
      return bytes.subarray(0, jpeg.length).equals(jpeg);
    case "image/gif":
      return ["GIF87a", "GIF89a"].includes(bytes.toString("latin1", 0, 6));
    case "image/webp":
      return bytes.toString("latin1", 0, 4) === "RIFF" && bytes.toString("latin1", 8, 12) === "WEBP";
    case "image/avif":
      return isAvif(bytes);
    case "image/svg+xml": {
      if (bytes.includes(0)) return false;
      try {
        return /<svg[\s>/]/u.test(utf8.decode(bytes));
      } catch {
        return false;
      }
    }
    default:
      return false;
  }
}

export async function readImageSide(
  root: string,
  head: string,
  change: ChangedPath,
  side: "old" | "new",
  run: GitRunner,
  gitDirs: string[],
): Promise<{ flag: "oversized" } | { bytes: Buffer } | null> {
  const type = diffImageType(side === "old" ? (change.oldPath ?? change.path) : change.path);
  const mode = side === "old" ? change.oldMode : change.newMode;
  if (!type || mode === "120000" || mode === "160000") return null;
  let bytes: Buffer;
  if (side === "new" && head === "worktree" && !change.newFromIndex) {
    try {
      const value = await readWorktree(root, change.path, gitDirs, LIMITS.assetBytes);
      if (!value || value.mode === "120000") return null;
      bytes = value.bytes;
    } catch (error) {
      if (error instanceof OversizedFile) return { flag: "oversized" };
      throw error;
    }
  } else {
    const value = await readGitBlob(root, run, side === "old" ? change.oldOid : change.newOid, LIMITS.assetBytes);
    if ("flag" in value) return value;
    bytes = value.bytes;
  }
  return recognizesImage(type, bytes) ? { bytes } : null;
}
