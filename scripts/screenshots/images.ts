// Writes a set of images into a folder all-or-nothing: either every target is replaced or every
// target is as it was, and no temporary or backup file stays behind.
import { randomUUID } from "node:crypto";
import { lstatSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface ImageOps {
  rename: (from: string, to: string) => void;
}

const defaultOps: ImageOps = { rename: renameSync };

/** A destination must be a regular file or missing; a directory, link or device is refused. */
function assertReplaceable(path: string): boolean {
  try {
    if (!lstatSync(path).isFile()) throw new Error("A screenshot destination is not a regular file");
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export function writeImages(folder: string, images: readonly (readonly [string, Buffer])[], ops = defaultOps): void {
  const entries = images.map(([name, bytes]) => ({
    target: join(folder, name),
    temporary: join(folder, `.${name}.${randomUUID()}.tmp`),
    backup: join(folder, `.${name}.${randomUUID()}.bak`),
    bytes,
    existed: false,
    movedAside: false,
    replaced: false,
  }));
  // Check every destination before touching anything.
  for (const entry of entries) entry.existed = assertReplaceable(entry.target);
  try {
    for (const entry of entries) writeFileSync(entry.temporary, entry.bytes, { flag: "wx", mode: 0o644 });
    for (const entry of entries) {
      if (entry.existed) {
        ops.rename(entry.target, entry.backup);
        entry.movedAside = true;
      }
      ops.rename(entry.temporary, entry.target);
      entry.replaced = true;
    }
  } catch (error) {
    // Put every original back, then drop what this call created.
    for (const entry of entries) {
      if (entry.replaced) rmSync(entry.target, { force: true });
      if (entry.movedAside) renameSync(entry.backup, entry.target);
      rmSync(entry.temporary, { force: true });
    }
    throw error;
  }
  for (const entry of entries) rmSync(entry.backup, { force: true });
}
