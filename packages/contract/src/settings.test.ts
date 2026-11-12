import { expect, test } from "vitest";
import {
  ApprovedActiveHours,
  HoursSetting,
  InboxList,
  KeyBinding,
  KeysSetting,
  MAX_APPROVED_ACTIVE_HOURS,
  normalizeShortcutKey,
  SCOPES_BY_KIND,
  SettingSource,
  SettingsUpdate,
  SettingsView,
  SHORTCUT_DEFAULTS,
  ShortcutCommand,
  ShortcutKey,
} from "./index.ts";

test("whole approved hours include both bounds", () => {
  expect(MAX_APPROVED_ACTIVE_HOURS).toBe(720);
  for (const value of [0, 1, 12, 720]) {
    expect(ApprovedActiveHours.parse(value)).toBe(value);
    expect(SettingsUpdate.parse({ approvedActiveHours: value })).toEqual({ approvedActiveHours: value });
  }
  expect(SettingsUpdate.parse({ approvedActiveHours: null })).toEqual({ approvedActiveHours: null });
});
test("updates reject invalid hours and unknown keys", () => {
  for (const value of [-1, 721, 1.5, "3", true, NaN, Infinity]) {
    expect(ApprovedActiveHours.safeParse(value).success).toBe(false);
    expect(SettingsUpdate.safeParse({ approvedActiveHours: value }).success).toBe(false);
  }
  expect(SettingsUpdate.safeParse({ approvedActiveHours: 12, other: true }).success).toBe(false);
});
test("settings expose the source and nullable file and override", () => {
  for (const source of SettingSource.options) {
    const setting = { value: 12, source, default: 12, file: null, override: null, fileError: false };
    const view = { approvedActiveHours: setting, keys: defaultKeys(), serverTime: "2026-11-04T10:00:00.000Z" };
    expect(SettingsView.parse(view)).toEqual(view);
    expect(SettingsView.safeParse({ approvedActiveHours: setting }).success).toBe(false);
    expect(SettingsView.safeParse({ ...view, serverTime: "yesterday" }).success).toBe(false);
    expect(HoursSetting.safeParse({ ...setting, source: "browser" }).success).toBe(false);
    expect(HoursSetting.safeParse({ ...setting, file: 25.5 }).success).toBe(false);
    expect(HoursSetting.safeParse({ ...setting, override: "12" }).success).toBe(false);
    expect(HoursSetting.safeParse({ ...setting, fileError: undefined }).success).toBe(false);
  }
});

function defaultKeys() {
  return {
    commands: Object.fromEntries(
      Object.entries(SHORTCUT_DEFAULTS).map(([command, key]) => [
        command,
        { value: key, source: "default", default: key, fileError: false, clashWith: null },
      ]),
    ),
    fileError: false,
  };
}

test("shortcut keys accept exactly normalized letters, shifted letters, digits and ASCII punctuation", () => {
  for (let code = 0; code <= 127; code++) {
    const key = String.fromCharCode(code);
    expect(ShortcutKey.safeParse(key).success, JSON.stringify(key)).toBe(
      code >= 33 && code <= 126 && !(code >= 65 && code <= 90),
    );
  }
  for (const key of ["j", "0", "9", "/", "?", "+", "\\", "shift+a", "shift+z"])
    expect(ShortcutKey.parse(key)).toBe(key);
  for (const key of [
    "ctrl+k",
    "alt+j",
    "meta+k",
    "Escape",
    "Tab",
    "Enter",
    "Space",
    "ArrowUp",
    "PageUp",
    "PageDown",
    "Home",
    "End",
    "F1",
    "F12",
    " ",
    "shift+1",
    "shift+?",
    "shift++",
    "A",
    "ab",
    "SHIFT+a",
    "shift+A",
    "",
    "é",
    "😀",
    "j\n",
    "shift+a\n",
    null,
    undefined,
    1,
  ])
    expect(ShortcutKey.safeParse(key).success, JSON.stringify(key)).toBe(false);
  expect(KeyBinding.parse(null)).toBeNull();
});

test("config keys normalize uppercase letters and any case of shift plus a letter only", () => {
  for (const key of Object.values(SHORTCUT_DEFAULTS)) expect(normalizeShortcutKey(key)).toBe(key);
  for (const key of ["A", "shift+A", "SHIFT+A", "sHiFt+a"]) expect(normalizeShortcutKey(key)).toBe("shift+a");
  expect(normalizeShortcutKey("Z")).toBe("shift+z");
  for (const key of [
    "ctrl+k",
    "Escape",
    " ",
    "shift+1",
    "SHIFT+?",
    "ab",
    " a",
    "A\n",
    "shift+A\n",
    "é",
    null,
    1,
    {},
    undefined,
  ])
    expect(normalizeShortcutKey(key)).toBeUndefined();
});

test("shortcut views contain every command and distinguish missing bindings from off", () => {
  expect(ShortcutCommand.options).toEqual(Object.keys(SHORTCUT_DEFAULTS));
  const keys = defaultKeys();
  expect(KeysSetting.parse(keys)).toEqual(keys);
  const { "inbox.next": next, ...rest } = keys.commands;
  expect(KeysSetting.safeParse({ ...keys, commands: rest }).success).toBe(false);
  expect(KeysSetting.safeParse({ ...keys, commands: { ...keys.commands, unknown: next } }).success).toBe(false);
  const off = { ...next, value: null, file: null, override: null };
  expect(
    KeysSetting.parse({ ...keys, commands: { ...keys.commands, "inbox.next": off } }).commands["inbox.next"],
  ).toEqual(off);
});

test("partial settings updates accept set, off, reset and empty updates", () => {
  for (const update of [
    {},
    { keys: {} },
    { keys: { "inbox.next": { key: "j" } } },
    { keys: { "inbox.next": { key: null }, "inbox.previous": null } },
    { approvedActiveHours: null, keys: { "review.approve": { key: "shift+b" } } },
  ])
    expect(SettingsUpdate.parse(update)).toEqual(update);
  for (const keys of [
    { unknown: { key: "j" } },
    { "inbox.next": { key: "A" } },
    { "inbox.next": { key: "shift+A" } },
    { "inbox.next": { key: "j", extra: true } },
    { "inbox.next": {} },
    { "inbox.next": "j" },
    null,
    { constructor: null },
    { toString: null },
  ])
    expect(SettingsUpdate.safeParse({ keys }).success).toBe(false);
});
test("only reviewers manage settings", () => {
  for (const [kind, scopes] of Object.entries(SCOPES_BY_KIND))
    expect(scopes.some((scope) => scope === "settings:manage")).toBe(kind === "reviewer");
});
test("inbox lists require the window used for their items", () => {
  const list = { items: [], serverTime: "2026-11-04T10:00:00.000Z" };
  expect(InboxList.safeParse(list).success).toBe(false);
  for (const approvedActiveHours of [0, 720])
    expect(InboxList.parse({ ...list, approvedActiveHours }).approvedActiveHours).toBe(approvedActiveHours);
});
