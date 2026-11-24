import { expect, test } from "vitest";
import {
  CLIENT_HEADER,
  LEGACY_CLIENT_HEADER,
  LEGACY_SERVER_CHALLENGE_HEADER,
  LEGACY_SERVER_PROOF_HEADER,
  LIMITS,
  SERVER_CHALLENGE_HEADER,
  SERVER_PROOF_HEADER,
  ServerChallenge,
  ServerProof,
} from "./index.ts";

test("server proof headers use bounded canonical 32-byte base64url values", () => {
  expect(SERVER_CHALLENGE_HEADER).toBe("X-Recense-Challenge");
  expect(SERVER_PROOF_HEADER).toBe("X-Recense-Proof");
  // The names before the rename travel next to the new ones.
  expect(LEGACY_SERVER_CHALLENGE_HEADER).toBe("X-Emend-Challenge");
  expect(LEGACY_SERVER_PROOF_HEADER).toBe("X-Emend-Proof");
  expect(CLIENT_HEADER).toBe("X-Recense-Client");
  expect(LEGACY_CLIENT_HEADER).toBe("X-Emend-Client");
  expect(LIMITS.publicJsonBytes).toBe(4096);
  for (const schema of [ServerChallenge, ServerProof]) {
    expect(schema.parse("A".repeat(43))).toBe("A".repeat(43));
    for (const value of [
      "",
      "A".repeat(42),
      "A".repeat(44),
      `${"A".repeat(42)}B`,
      `${"A".repeat(42)}=`,
      "!".repeat(43),
    ]) {
      expect(schema.safeParse(value).success).toBe(false);
    }
  }
});
