import { type KeyBinding, KeysSetting, SHORTCUT_DEFAULTS, type ShortcutCommand } from "@emend/contract";
import { expect, test } from "vitest";
import { resolveShortcuts } from "./index.ts";

function resolve(
  file: Partial<Record<ShortcutCommand, KeyBinding>> = {},
  overrides: Partial<Record<ShortcutCommand, KeyBinding>> = {},
  fileErrors: ReadonlySet<ShortcutCommand> = new Set(),
) {
  return resolveShortcuts({ file, overrides, fileErrors });
}

test("defaults are unique and resolve without clashes", () => {
  expect(new Set(Object.values(SHORTCUT_DEFAULTS)).size).toBe(Object.keys(SHORTCUT_DEFAULTS).length);
  const commands = resolve();
  expect(Object.keys(commands)).toEqual(Object.keys(SHORTCUT_DEFAULTS));
  expect(KeysSetting.parse({ commands, fileError: false }).commands).toEqual(commands);
  for (const [command, key] of Object.entries(SHORTCUT_DEFAULTS))
    expect(commands[command as ShortcutCommand]).toEqual({
      value: key,
      source: "default",
      default: key,
      fileError: false,
      clashWith: null,
    });
});

test("a file binding takes a default's key and leaves the default holder off", () => {
  const commands = resolve({ "inbox.next": "k" });
  expect(commands["inbox.next"]).toEqual({
    value: "k",
    source: "file",
    default: "j",
    file: "k",
    fileError: false,
    clashWith: null,
  });
  expect(commands["inbox.previous"]).toEqual({
    value: null,
    source: "default",
    default: "k",
    fileError: false,
    clashWith: "inbox.next",
  });
});

test("equal file bindings both fall back and report each other", () => {
  const commands = resolve({ "inbox.next": "x", "inbox.previous": "x" });
  expect(commands["inbox.next"]).toMatchObject({
    value: "j",
    source: "default",
    file: "x",
    clashWith: "inbox.previous",
  });
  expect(commands["inbox.previous"]).toMatchObject({
    value: "k",
    source: "default",
    file: "x",
    clashWith: "inbox.next",
  });
});

test("an override beats a file entry and the loser falls back", () => {
  const commands = resolve({ "inbox.next": "x" }, { "inbox.previous": "x" });
  expect(commands["inbox.next"]).toMatchObject({
    value: "j",
    source: "default",
    file: "x",
    clashWith: "inbox.previous",
  });
  expect(commands["inbox.previous"]).toMatchObject({ value: "x", source: "override", override: "x", clashWith: null });
});

test("off is a present candidate and never clashes; file errors survive resolution", () => {
  const commands = resolve(
    { "inbox.next": "x", "inbox.previous": null, "inbox.filter": null },
    { "inbox.next": null, "inbox.search": null },
    new Set(["inbox.search"]),
  );
  expect(commands["inbox.next"]).toEqual({
    value: null,
    source: "override",
    default: "j",
    file: "x",
    override: null,
    fileError: false,
    clashWith: null,
  });
  expect(commands["inbox.previous"]).toMatchObject({ value: null, source: "file", file: null, clashWith: null });
  expect(commands["inbox.filter"]).toMatchObject({ value: null, source: "file", file: null, clashWith: null });
  expect(commands["inbox.search"]).toMatchObject({ value: null, source: "override", fileError: true, clashWith: null });
});

test("a chain consumes candidates over several passes and records the last clash", () => {
  const commands = resolve(
    { "inbox.next": "k", "inbox.previous": "f", "inbox.filter": "f" },
    { "inbox.next": "x", "inbox.previous": "x" },
  );
  expect(commands["inbox.next"]).toMatchObject({ value: "k", source: "file", clashWith: "inbox.previous" });
  expect(commands["inbox.previous"]).toMatchObject({ value: null, source: "default", clashWith: "inbox.next" });
  expect(commands["inbox.filter"]).toMatchObject({ value: "f", source: "default", clashWith: "inbox.previous" });
  const keys = Object.values(commands).flatMap(({ value }) => (value === null ? [] : [value]));
  expect(new Set(keys).size).toBe(keys.length);
});

test("ties use command order even for lower-level losers and regardless of input order", () => {
  const commands = resolve({}, { "inbox.filter": "j", "inbox.previous": "j" });
  expect(commands["inbox.next"]).toMatchObject({ value: null, source: "default", clashWith: "inbox.previous" });
  expect(commands["inbox.previous"]).toMatchObject({ value: "k", source: "default", clashWith: "inbox.filter" });
  expect(commands["inbox.filter"]).toMatchObject({ value: "f", source: "default", clashWith: "inbox.previous" });
});
