import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LIMITS } from "@emend/contract";
import { expect, test, vi } from "vitest";
import * as http from "../http.ts";
import { provenTestServer } from "../test-support.ts";
import { upload, uploadTimeoutMs } from "./upload.ts";

test.each([
  [0, 5000],
  [1, 6000],
  [1048576, 6000],
  [1048576 + 1, 7000],
  [LIMITS.assetBytes, 30000],
])("blob upload timeout for %i bytes is %i ms", (bytes, timeoutMs) => {
  expect(uploadTimeoutMs(bytes)).toBe(timeoutMs);
});

test("second publish uploads no blobs and every upload proves the server", async () => {
  const dir = await mkdtemp(join(tmpdir(), "emend-upload-"));
  const request = vi.spyOn(http, "apiRequest");
  try {
    await writeFile(join(dir, "agent.token"), `em_${"a".repeat(43)}`, { mode: 0o600 });
    const proof = provenTestServer(dir);
    const known = new Set<string>();
    let puts = 0;
    let proofs = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        const proven = proof(url, init);
        if (proven) {
          proofs++;
          return proven;
        }
        const sha = String(url).split("/").at(-1) ?? "";
        if (init?.method === "HEAD") return new Response(null, { status: known.has(sha) ? 204 : 404 });
        expect(init?.method).toBe("PUT");
        expect(new Headers(init?.headers).get("Content-Length")).toBe("5");
        expect(init?.body).toEqual(new Uint8Array(Buffer.from("hello")));
        puts++;
        known.add(sha);
        return new Response(null, { status: 204 });
      }),
    );
    const bytes = Buffer.from("hello");
    const hash = createHash("sha256").update(bytes).digest("hex");
    const read = vi.fn(async () => bytes);
    const content = new Map([[hash, { size: bytes.length, read }]]);
    await upload(dir, "http://127.0.0.1:3636", content);
    await upload(dir, "http://127.0.0.1:3636", content);
    expect(request).toHaveBeenCalledWith(dir, expect.anything(), `/blobs/${hash}`, {
      method: "PUT",
      raw: bytes,
      timeoutMs: 6000,
    });
    expect(request).toHaveBeenCalledWith(dir, expect.anything(), `/blobs/${hash}`, {
      method: "HEAD",
      missingOk: true,
    });
    expect(puts).toBe(1);
    expect(proofs).toBe(3);
    expect(read).toHaveBeenCalledTimes(1);
  } finally {
    request.mockRestore();
    vi.unstubAllGlobals();
    await rm(dir, { recursive: true, force: true });
  }
});
