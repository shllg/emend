import { randomUUID } from "node:crypto";
import { linkSync, readFileSync, rmSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { ensureStateDir, syncDirectory, tightenSecretFile, writeSecretFile } from "./files.ts";

export interface Instance {
  id: string;
  name: string;
}

export async function loadOrCreateInstance(dir: string): Promise<Instance> {
  ensureStateDir(dir);
  const path = join(dir, "instance.json");
  let source: string;
  try {
    tightenSecretFile(path);
    source = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const temporary = join(dir, `.instance-${randomUUID()}.tmp`);
    try {
      writeSecretFile(temporary, JSON.stringify({ id: randomUUID(), name: hostname() }));
      try {
        linkSync(temporary, path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    } finally {
      rmSync(temporary, { force: true });
      syncDirectory(dir);
    }
    tightenSecretFile(path);
    source = readFileSync(path, "utf8");
  }
  const value: unknown = JSON.parse(source);
  if (
    !value ||
    typeof value !== "object" ||
    !("id" in value) ||
    typeof value.id !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.id) ||
    !("name" in value) ||
    typeof value.name !== "string"
  )
    throw new Error("Invalid instance.json");
  return { id: value.id, name: value.name };
}
