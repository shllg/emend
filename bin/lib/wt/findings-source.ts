import { createHash } from "node:crypto";

export function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function findingLines(blob: Buffer): string[] {
  const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(blob);
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

export function findingAnchor(line: string): string {
  return sha256(line.trim());
}
