import { createHmac } from "node:crypto";

export function serverProof(key: string, challenge: string): string {
  return createHmac("sha256", Buffer.from(key, "base64url")).update(challenge, "ascii").digest("base64url");
}
