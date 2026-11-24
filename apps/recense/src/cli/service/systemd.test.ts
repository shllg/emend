import { expect, test } from "vitest";
import { systemdWord } from "./systemd.ts";

test.each([
  ["/plain/path", "/plain/path"],
  ["/with space/path", '"/with space/path"'],
  ["/with\ttab/path", '"/with\ttab/path"'],
  ['/with"quote', '"/with\\"quote"'],
  ["/with'quote", '"/with\'quote"'],
  ["/with\\backslash", '"/with\\\\backslash"'],
  ["/percent%and$dollar", "/percent%%and$$dollar"],
])("systemd quotes the ExecStart word %j", (value, expected) => {
  expect(systemdWord(value, true)).toBe(expected);
});

test("systemd Environment leaves dollar signs literal and escapes percent specifiers", () => {
  expect(systemdWord("RECENSE_HOME=/space %h $HOME", false)).toBe('"RECENSE_HOME=/space %%h $HOME"');
});
