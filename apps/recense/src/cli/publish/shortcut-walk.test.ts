import { expect, test } from "vitest";
import { holdsPrivateKey } from "./shortcut-walk.ts";

const header = "-----BEGIN PRIVATE KEY-----"; // check-public: allow

test.each([
  header,
  "-----BEGIN PGP PRIVATE KEY BLOCK-----", // check-public: allow
  "---- BEGIN SSH2 ENCRYPTED PRIVATE KEY ----",
  "PuTTY-User-Key-File-",
  "AGE-SECRET-KEY-1",
  `-----BEGIN ${"A".repeat(100)} PRIVATE KEY-----`,
])("a private-key marker alone is enough: %s", (marker) => {
  expect(holdsPrivateKey(Buffer.from(JSON.stringify({ marker })))).toBe(true);
});

test("text without a private-key marker is allowed", () => {
  expect(holdsPrivateKey(Buffer.from("Synthetic public text"))).toBe(false);
});

test("the byte detector honors Uint8Array bounds and sees UTF-16LE markers", () => {
  const bytes = Buffer.from(`prefix${header}`, "utf16le");
  expect(holdsPrivateKey(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength))).toBe(true);
  expect(holdsPrivateKey(new Uint8Array(bytes.buffer, bytes.byteOffset, 12))).toBe(false);
});
