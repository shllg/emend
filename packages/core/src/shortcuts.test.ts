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

test("an override taking a jump key leaves the default jump off", () => {
  const commands = resolve({}, { "tab.writeup": "alt+1" });
  expect(commands["tab.writeup"]).toMatchObject({ value: "alt+1", source: "override" });
  expect(commands["inbox.jump1"]).toMatchObject({ value: null, source: "default", clashWith: "tab.writeup" });
});

function jumpGroup(modifier: "alt" | "mod" | null): Partial<Record<ShortcutCommand, KeyBinding>> {
  return Object.fromEntries(
    Array.from({ length: 9 }, (_, index) => [
      `inbox.jump${index + 1}`,
      modifier === null ? null : `${modifier}+${index + 1}`,
    ]),
  );
}

for (const source of ["override", "file"] as const) {
  test.each([
    [null, null],
    ["mod", null],
    ["alt", "alt+0"],
  ] as const)(`a saved ${source} group of %s fills row ten with %s without mutating the input`, (modifier, tenth) => {
    const group = Object.freeze(jumpGroup(modifier));
    const commands = source === "override" ? resolve({}, group) : resolve(group);
    expect(commands["inbox.jump10"]).toEqual({
      value: tenth,
      source,
      default: "alt+0",
      [source]: tenth,
      fileError: false,
      clashWith: null,
    });
    expect(Object.hasOwn(group, "inbox.jump10")).toBe(false);
  });

  test.each(["mixed", "partial", "inherited"])(`a %s ${source} group leaves row ten at its default`, (kind) => {
    let group = jumpGroup(null);
    if (kind === "mixed") group["inbox.jump9"] = "mod+9";
    else if (kind === "partial") delete group["inbox.jump9"];
    else group = Object.create(group);
    const commands = source === "override" ? resolve({}, group) : resolve(group);
    expect(commands["inbox.jump10"]).toEqual({
      value: "alt+0",
      source: "default",
      default: "alt+0",
      fileError: false,
      clashWith: null,
    });
  });

  test.each([
    [null, "x"],
    ["alt", null],
  ] as const)(`an explicit tenth ${source} key wins over the %s group fill`, (modifier, tenth) => {
    const group = { ...jumpGroup(modifier), "inbox.jump10": tenth };
    const commands = source === "override" ? resolve({}, group) : resolve(group);
    expect(commands["inbox.jump10"]).toMatchObject({ value: tenth, source, [source]: tenth });
  });
}

test("file and override jump groups fill independently, with the override taking precedence", () => {
  const commands = resolve(jumpGroup("alt"), jumpGroup("mod"));
  expect(commands["inbox.jump10"]).toEqual({
    value: null,
    source: "override",
    default: "alt+0",
    file: "alt+0",
    override: null,
    fileError: false,
    clashWith: null,
  });
});

test("a file error for row ten blocks the file fill but allows an override fill", () => {
  const file = Object.freeze(jumpGroup(null));
  const fileErrors = new Set<ShortcutCommand>(["inbox.jump10"]);
  expect(resolve(file, {}, fileErrors)["inbox.jump10"]).toEqual({
    value: "alt+0",
    source: "default",
    default: "alt+0",
    fileError: true,
    clashWith: null,
  });
  expect(resolve(file, jumpGroup("mod"), fileErrors)["inbox.jump10"]).toEqual({
    value: null,
    source: "override",
    default: "alt+0",
    override: null,
    fileError: true,
    clashWith: null,
  });
});

test("a filled override wins a clash with a file binding", () => {
  const commands = resolve({ "tab.writeup": "alt+0" }, jumpGroup("alt"));
  expect(commands["inbox.jump10"]).toMatchObject({
    value: "alt+0",
    source: "override",
    override: "alt+0",
    clashWith: null,
  });
  expect(commands["tab.writeup"]).toMatchObject({ value: "1", source: "default", clashWith: "inbox.jump10" });
});

test("a filled file binding loses a clash with an override", () => {
  const commands = resolve(jumpGroup("alt"), { "tab.writeup": "alt+0" });
  expect(commands["inbox.jump10"]).toMatchObject({
    value: null,
    source: "default",
    file: "alt+0",
    clashWith: "tab.writeup",
  });
  expect(commands["tab.writeup"]).toMatchObject({ value: "alt+0", source: "override", clashWith: null });
});
