import assert from "node:assert/strict";
import fs, { mkdtempSync, rmSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { localDiagnostic, pushDiagnostic, repoDiagnostic } from "./diagnostics.ts";
import type { Repo } from "./repo.ts";

test("R9.6: diagnostics remove display controls and withhold secret, generic and private lines", () => {
  const mail = ["person", "mail.fixture"].join("@");
  const token = ["gh", "p_", "Ab01".repeat(9)].join("");
  const home = ["/", "home", "/", "alice-example", "/file"].join("");
  const terms = { terms: [{ value: "alice example", line: 1 }], allowed: [], notes: [] };
  const text = ["public\u202e\u2028\u2029\u200b", mail, token, home, "alice-example", "still public"].join("\n");
  assert.equal(
    pushDiagnostic(text, terms),
    [
      "public",
      "[line withheld: email address]",
      "[line withheld: secret shape]",
      "[line withheld: real home path]",
      "[line withheld: private term (file line 1)]",
      "still public",
    ].join("\n"),
  );
  assert.equal(pushDiagnostic(`${"x".repeat(2100)} ${mail}`, terms), "[line withheld: email address]");
});

test("R10.E: local diagnostics only remove controls and never load terms", (t) => {
  const mail = ["person", "mail.fixture"].join("@");
  const text = `${mail}\u202e\x1b[31m\n${"ordinary error\n".repeat(25)}${"x".repeat(2100)}`;
  const reader = t.mock.method(fs, "readFileSync", () => {
    throw new Error("unexpected file read");
  });
  syncBuiltinESMExports();
  try {
    assert.equal(localDiagnostic(text), `${mail}\n${"ordinary error\n".repeat(25)}${"x".repeat(2100)}`);
    assert.equal(reader.mock.callCount(), 0);
  } finally {
    reader.mock.restore();
    syncBuiltinESMExports();
  }
});

test("R10.E: local diagnostics trim trailing display whitespace but preserve indentation", () => {
  assert.equal(
    localDiagnostic("  synthetic git failure\n\tindented detail \t\r\n"),
    "  synthetic git failure\n\tindented detail",
  );
  assert.equal(localDiagnostic("\x1b[31m \u202e\t\r\n"), "");
});

test("R10.E: relayed diagnostics withhold every line of wrapped terms and tokens", () => {
  const terms = { terms: [{ value: "alice example", line: 1 }], allowed: [], notes: [] };
  const token = ["gh", "p_", "Ab01".repeat(9)].join("");
  for (const [text, label] of [
    ["alice\n  example", "private term (file line 1)"],
    [`${token.slice(0, 24)}\n${token.slice(24)}`, "secret shape"],
  ])
    assert.equal(
      pushDiagnostic(`ordinary error!\n${text}\n!still readable`, terms),
      `ordinary error!\n[line withheld: ${label}]\n[line withheld: ${label}]\n!still readable`,
    );
  // The same scan must protect lines whose match continues beyond the output line cap.
  assert.equal(
    pushDiagnostic(`${"public\n".repeat(19)}alice\nexample`, terms)
      .split("\n")
      .at(-1),
    "[line withheld: private term (file line 1)]",
  );
});

test("R10.E: missing or unreadable terms keep ordinary remote errors readable and secrets withheld", (t) => {
  const root = mkdtempSync(join(tmpdir(), "wt-diagnostic-"));
  const repo = { mainRoot: root } as Repo;
  const token = ["gh", "p_", "Ab01".repeat(9)].join("");
  const stderr = `ordinary git error\n${token}\n!still readable`;
  const expected = "ordinary git error\n[line withheld: secret shape]\n!still readable";
  try {
    assert.equal(repoDiagnostic(repo, stderr), expected);
    const reader = t.mock.method(fs, "readFileSync", () => {
      throw new Error("synthetic unreadable file");
    });
    syncBuiltinESMExports();
    try {
      assert.equal(repoDiagnostic(repo, stderr), expected);
      assert.equal(reader.mock.callCount(), 1);
    } finally {
      reader.mock.restore();
      syncBuiltinESMExports();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("R11.C: key headers and combining runs withhold the whole relay with or without terms", (t) => {
  const root = mkdtempSync(join(tmpdir(), "wt-diagnostic-"));
  const repo = { mainRoot: root } as Repo;
  const token = ["gh", "p_", "Ab01".repeat(9)].join("");
  try {
    for (const available of [true, false]) {
      const reader = t.mock.method(fs, "readFileSync", () => {
        if (available) return Buffer.from("alice example\n");
        throw Object.assign(new Error("synthetic missing list"), { code: "ENOENT" });
      });
      syncBuiltinESMExports();
      try {
        for (const [trigger, reason] of [
          ["\u0301\uff9e".repeat(17), "combining-mark run"],
          [["-----BEGIN RSA ", "PRIVATE KEY-----"].join(""), "secret shape"],
          [["PuTTY-User-", "Key-File-3:"].join(""), "secret shape"],
          [["---- BEGIN SSH2 ENCRYPTED ", "PRIVATE KEY ----"].join(""), "secret shape"],
          [["AGE-SECRET-", "KEY-1"].join(""), "secret shape"],
        ]) {
          const stderr = `ordinary error\n${trigger}\n${token}`;
          assert.equal(repoDiagnostic(repo, stderr), `[diagnostic withheld: ${reason}]`);
        }
      } finally {
        reader.mock.restore();
        syncBuiltinESMExports();
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("R11.C: relayed scanning stops at 64 KiB before sanitizing and keeps output limits", () => {
  const token = ["gh", "p_", "Ab01".repeat(9)].join("");
  const header = ["-----BEGIN RSA ", "PRIVATE KEY-----"].join("");
  for (const prefix of ["x".repeat(64 * 1024), "é".repeat(32 * 1024)]) {
    assert.equal(pushDiagnostic(prefix + token), prefix.slice(0, 2000));
    assert.equal(pushDiagnostic(prefix + header), prefix.slice(0, 2000));
  }
  assert.equal(pushDiagnostic("\u200b".repeat((64 * 1024) / 2) + token), "");
  assert.equal(pushDiagnostic("ordinary\n".repeat(100)).split("\n").length, 20);
  const prefix = `${"x".repeat(64 * 1024 - token.length - 1)} `;
  assert.equal(pushDiagnostic(prefix + token), "[line withheld: secret shape]");
});

test("R11.C: every withheld line uses a label from a span covering that line", () => {
  const mail = ["person", "mail.fixture"].join("@");
  const terms = { terms: [{ value: "alice example", line: 1 }], allowed: [], notes: [] };
  const lines = pushDiagnostic(`${mail} alice\nexample\n!ordinary`, terms).split("\n");
  assert.match(lines[0] ?? "", /^\[line withheld: (email address|private term \(file line 1\))\]$/);
  assert.equal(lines[1], "[line withheld: private term (file line 1)]");
  assert.equal(lines[2], "!ordinary");
});
