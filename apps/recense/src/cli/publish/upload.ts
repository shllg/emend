import { createHash } from "node:crypto";
import { apiRequest, CliError } from "../http.ts";
import { type HttpTarget, localTarget } from "../target.ts";

export type BlobSource = { size: number; read(): Promise<Buffer> };

/** Returns the CLI publish blob upload timeout in milliseconds for the given byte count. */
export function uploadTimeoutMs(bytes: number): number {
  return 5000 + Math.ceil(bytes / 1048576) * 1000;
}

export async function readBlob(hash: string, source: BlobSource): Promise<Buffer> {
  const bytes = await source.read();
  if (bytes.length !== source.size || createHash("sha256").update(bytes).digest("hex") !== hash)
    throw new CliError("blob changed before upload");
  return bytes;
}

export async function upload(
  stateDir: string,
  baseUrl: string | HttpTarget,
  blobs: Map<string, BlobSource>,
): Promise<void> {
  if (!blobs.size) return;
  const target = typeof baseUrl === "string" ? await localTarget(stateDir, baseUrl) : baseUrl;
  for (const [hash, source] of blobs) {
    const path = `/blobs/${hash}`;
    const exists = await apiRequest(stateDir, target, path, { method: "HEAD", missingOk: true });
    if (exists) continue;
    const bytes = await readBlob(hash, source);
    await apiRequest(stateDir, target, path, {
      method: "PUT",
      raw: bytes,
      timeoutMs: uploadTimeoutMs(bytes.length),
    });
  }
}
