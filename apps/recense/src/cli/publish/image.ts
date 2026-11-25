import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import { join } from "node:path";
import {
  type DiffImage,
  DiffImageMediaType,
  diffImageType,
  type FileFlag,
  LIMITS,
  type PublishFile,
} from "@recense/contract";
import type { GitRunner } from "../git.ts";
import { CliError } from "../http.ts";
import { readRegular } from "./read.ts";
import { type ChangedPath, isBinarySide, readGitBlob } from "./sides.ts";
import type { BlobSource } from "./upload.ts";
import { statWorktree } from "./worktree.ts";

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

export type ImageBlob = BlobSource & { hash: string };
type ImageObject = {
  textFlag: FileFlag | null;
  types: DiffImageMediaType[];
  blob: ImageBlob | null;
};
const oversized: ImageObject = { textFlag: "oversized", types: [], blob: null };
type ReadObject = (recheck?: boolean) => Promise<{ bytes: Buffer } | { flag: "oversized" }>;

async function inspectObject(read: ReadObject): Promise<ImageObject> {
  const value = await read();
  if ("flag" in value) return oversized;
  const { bytes } = value;
  // One object may appear under several extensions. Cache signatures, never the bytes.
  const types = DiffImageMediaType.options.filter((type) => recognizesImage(type, bytes));
  return {
    textFlag: bytes.length > LIMITS.diffSideBytes ? "oversized" : isBinarySide(bytes) ? "binary" : null,
    types,
    blob: {
      hash: createHash("sha256").update(bytes).digest("hex"),
      size: bytes.length,
      read: async () => {
        const next = await read(true);
        if (!("bytes" in next) || types.some((type) => !recognizesImage(type, next.bytes)))
          throw new CliError("image changed before upload");
        return next.bytes;
      },
    },
  };
}

function diskKey(info: Stats) {
  if (!Number.isSafeInteger(info.ino) || info.ino === 0 || !Number.isSafeInteger(info.dev)) return undefined;
  return `disk:${info.dev}:${info.ino}:${info.size}:${info.ctimeMs}:${info.mtimeMs}`;
}

export function createImageResolver(
  root: string,
  run: GitRunner,
  gitDirs: string[],
  reserve: (sources: ImageBlob[]) => (() => void) | undefined,
) {
  const cache = new Map<string, ImageObject>();
  async function cached(key: string | undefined, read: ReadObject) {
    if (!key) return inspectObject(read);
    const hit = cache.get(key);
    if (hit) return hit;
    const object = await inspectObject(read);
    cache.set(key, object);
    return object;
  }
  async function objectFor(change: ChangedPath, head: string, side: "old" | "new") {
    if (side !== "new" || head !== "worktree" || change.newFromIndex) {
      const oid = side === "old" ? change.oldOid : change.newOid;
      if (!oid) throw new CliError("missing git object id");
      return cached(oid, () => readGitBlob(root, run, oid, LIMITS.assetBytes));
    }
    const info = await statWorktree(root, change.path, gitDirs);
    if (!info?.isFile()) throw new CliError("file changed while reading");
    // The same inode may change during resolve. Its checked stat also distinguishes versions.
    const key = diskKey(info);
    if (info.size > LIMITS.assetBytes) return oversized;
    return cached(key, async (recheck) => ({
      bytes: await readRegular(join(root, change.path), LIMITS.assetBytes, [root], undefined, gitDirs, (opened) => {
        if (!recheck && diskKey(opened) !== key) throw new CliError("file changed while reading");
      }),
    }));
  }

  return async (file: PublishFile, change: ChangedPath, head: string) => {
    const sides = (["old", "new"] as const).filter((side) =>
      side === "old" ? change.status !== "added" : change.status !== "deleted",
    );
    const types = { old: diffImageType(change.oldPath ?? change.path), new: diffImageType(change.path) };
    if (!sides.every((side) => types[side] && (side === "old" ? change.oldMode : change.newMode)?.startsWith("100")))
      return false;

    const text: ImageBlob[] = [];
    const pictures: ImageBlob[] = [];
    const image: DiffImage = { old: null, new: null };
    for (const side of sides) {
      const object = await objectFor(change, head, side);
      const type = types[side];
      const flag = side === "new" && change.newOversized ? "oversized" : object.textFlag;
      file.flag ??= flag;
      if (!file.flag && object.blob) {
        file[side === "old" ? "oldBlob" : "newBlob"] = object.blob.hash;
        text.push(object.blob);
      }
      if (!object.blob) image[side] = { flag: "oversized" };
      else if (type && object.types.includes(type)) {
        image[side] = { blob: object.blob.hash };
        pictures.push(object.blob);
      }
    }
    const saveText = reserve(text);
    if (!saveText) file.flag = "oversized";
    if (file.flag) file.oldBlob = file.newBlob = null;
    else saveText?.();
    if (sides.every((side) => image[side])) {
      const savePictures = reserve(pictures);
      if (savePictures) {
        savePictures();
        file.image = image;
      }
    }
    return true;
  };
}
