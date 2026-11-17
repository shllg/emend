import { afterEach, expect, test } from "vitest";
import {
  ariaKeyShortcuts,
  captureShortcut,
  digitOf,
  hasOpenOverlay,
  ignoreShortcut,
  jumpBadge,
  jumpKeysLabel,
  keyCaps,
  keyLabel,
  matchesShortcut,
} from "./shortcuts.ts";

const key = (value: string, options: KeyboardEventInit = {}) =>
  new KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true, ...options });
afterEach(() => document.body.replaceChildren());

test.each([
  ["j", "j", {}, true],
  ["J", "j", {}, true],
  ["J", "shift+j", {}, false],
  ["J", "j", { shiftKey: true }, false],
  ["J", "shift+j", { shiftKey: true }, true],
  ["?", "?", { shiftKey: true }, true],
  ["/", "/", {}, true],
  ["2", "2", { shiftKey: true }, true],
  ["@", "2", { shiftKey: true }, false],
  ["j", null, {}, false],
] as const)("matches typed %s against %s (%j)", (typed, binding, options, expected) => {
  expect(matchesShortcut(key(typed, options), binding)).toBe(expected);
});
test.each(["ctrlKey", "metaKey"])("%s is available only to mod bindings", (modifier) => {
  const event = key("k", { [modifier]: true });
  expect(matchesShortcut(event, "k")).toBe(false);
  expect(matchesShortcut(event, "mod+k")).toBe(true);
  expect(matchesShortcut(event, "mod+shift+k")).toBe(false);
  expect(ignoreShortcut(event)).toBe(false);
  expect(captureShortcut(event)).toEqual({ key: "mod+k" });
  const shifted = key("K", { [modifier]: true, shiftKey: true });
  expect(matchesShortcut(shifted, "mod+k")).toBe(false);
  expect(matchesShortcut(shifted, "mod+shift+k")).toBe(true);
  expect(captureShortcut(shifted)).toEqual({ key: "mod+shift+k" });
});
test.each([{ altKey: true }, { altKey: true, ctrlKey: true }, { altKey: true, metaKey: true }])(
  "Alt letter combinations never match or capture (%j)",
  (options) => {
    const event = key("k", options);
    for (const binding of ["k", "mod+k", "mod+shift+k"]) expect(matchesShortcut(event, binding)).toBe(false);
    expect(ignoreShortcut(event)).toBe(true);
    expect(captureShortcut(event)).toEqual({ error: "Alt works only with a digit." });
  },
);
test.each([
  ["1", { ctrlKey: true, shiftKey: true }],
  ["?", { metaKey: true }],
  ["Enter", { ctrlKey: true }],
  ["k", { ctrlKey: true, metaKey: true }],
  ["é", { metaKey: true }],
] as const)("refuses mod capture for %s (%j)", (typed, options) => {
  expect(captureShortcut(key(typed, options))).toEqual({ error: "Use Ctrl or ⌘ with one letter or digit." });
});
test("mod bindings require exactly one Ctrl or Meta and the matching letter", () => {
  expect(matchesShortcut(key("k"), "mod+k")).toBe(false);
  expect(matchesShortcut(key("k", { ctrlKey: true, metaKey: true }), "mod+k")).toBe(false);
  expect(matchesShortcut(key("p", { ctrlKey: true }), "mod+k")).toBe(false);
});
test.each(["Shift", "Control", "Meta", "Alt", "AltGraph"])("waits silently when only %s is pressed", (typed) => {
  expect(captureShortcut(key(typed))).toEqual({});
  expect(captureShortcut(key(typed, { ctrlKey: true, altKey: true, shiftKey: true, metaKey: true }))).toEqual({});
});
test.each([
  ["A", false, "a"],
  ["A", true, "shift+a"],
  ["a", true, "shift+a"],
  ["?", true, "?"],
  ["5", false, "5"],
  ["/", false, "/"],
])("normalizes %s, Shift=%s", (typed, shiftKey, expected) => {
  expect(captureShortcut(key(typed, { shiftKey }))).toEqual({ key: expected });
});
test.each(["Enter", " ", "ArrowLeft", "PageUp", "PageDown", "Home", "End", "F1", "é", "Dead"])(
  "refuses %s",
  (typed) => {
    expect(captureShortcut(key(typed))).toEqual({ error: "Use a letter, a digit or a punctuation key." });
  },
);
test("key labels use the platform and preserve punctuation", () => {
  expect(keyLabel("mod+shift+p", "MacIntel")).toBe("⌘⇧P");
  expect(keyLabel("mod+k", "MacIntel")).toBe("⌘K");
  expect(keyLabel("mod+shift+p", "Linux x86_64")).toBe("Ctrl+Shift+P");
  expect(keyLabel("mod+k", "Linux x86_64")).toBe("Ctrl+K");
  expect(keyLabel("shift+a", "MacIntel")).toBe("⇧A");
  expect(keyLabel("shift+a", "Linux x86_64")).toBe("Shift+A");
  for (const platform of ["MacIntel", "Linux x86_64"]) {
    for (const value of ["j", "/", "?"]) expect(keyLabel(value, platform)).toBe(value);
    expect(keyLabel(null, platform)).toBe("Off");
  }
});
test.each([
  ["MacIntel", ["⌘", "⇧", "P"], ["⌘", "K"], ["⇧", "A"]],
  ["Linux x86_64", ["Ctrl", "Shift", "P"], ["Ctrl", "K"], ["Shift", "A"]],
] as const)("key caps use %s and preserve plain keys", (platform, palette, mod, shift) => {
  expect(keyCaps("mod+shift+p", platform)).toEqual(palette);
  expect(keyCaps("mod+k", platform)).toEqual(mod);
  expect(keyCaps("shift+a", platform)).toEqual(shift);
  for (const value of ["j", "/", "?"]) expect(keyCaps(value, platform)).toEqual([value]);
});
test.each([
  ["MacIntel", "Meta+Shift+P", "Meta+K"],
  ["Linux x86_64", "Control+Shift+P", "Control+K"],
])("ARIA key shortcuts use %s and name the plus key", (platform, palette, mod) => {
  expect(ariaKeyShortcuts("mod+shift+p", platform)).toBe(palette);
  expect(ariaKeyShortcuts("mod+k", platform)).toBe(mod);
  expect(ariaKeyShortcuts("shift+a", platform)).toBe("Shift+A");
  expect(ariaKeyShortcuts("j", platform)).toBe("J");
  for (const value of ["/", "?"]) expect(ariaKeyShortcuts(value, platform)).toBe(value);
  expect(ariaKeyShortcuts("+", platform)).toBe("Plus");
});
test.each(["text", "search", "number", "email", "password", "url", "tel", "date"])("ignores %s inputs", (type) => {
  const input = document.createElement("input");
  input.type = type;
  const event = key("j");
  input.dispatchEvent(event);
  expect(ignoreShortcut(event)).toBe(true);
});
test.each(["checkbox", "radio", "button", "submit", "reset", "range", "color", "file", "image"])(
  "allows %s inputs",
  (type) => {
    const input = document.createElement("input");
    input.type = type;
    const event = key("j");
    input.dispatchEvent(event);
    expect(ignoreShortcut(event)).toBe(false);
  },
);
test.each(["textarea", "select", "editable"])("ignores %s and editable descendants", (type) => {
  const input = document.createElement(type === "editable" ? "div" : type);
  if (type === "editable") input.setAttribute("contenteditable", "true");
  const child = type === "editable" ? input.appendChild(document.createElement("span")) : input;
  const event = key("j");
  child.dispatchEvent(event);
  expect(ignoreShortcut(event)).toBe(true);
});
test.each([{ repeat: true }, { isComposing: true }, { keyCode: 229 }])("ignores %j", (options) => {
  expect(ignoreShortcut(key("j", options))).toBe(true);
});
test("ignores defaultPrevented", () => {
  const event = key("j");
  event.preventDefault();
  expect(ignoreShortcut(event)).toBe(true);
});
test.each(["dialog", "alertdialog", "menu"])("ignores open %s, but not closed or hidden content", (role) => {
  const content = document.body.appendChild(document.createElement("div"));
  content.setAttribute("role", role);
  expect(hasOpenOverlay()).toBe(true);
  expect(ignoreShortcut(key("j"))).toBe(true);
  content.setAttribute("data-state", "closed");
  expect(hasOpenOverlay()).toBe(false);
  expect(ignoreShortcut(key("j"))).toBe(false);
  content.setAttribute("data-state", "open");
  content.hidden = true;
  expect(hasOpenOverlay()).toBe(false);
  expect(ignoreShortcut(key("j"))).toBe(false);
  content.hidden = false;
  const parent = document.body.appendChild(document.createElement("div"));
  parent.hidden = true;
  parent.appendChild(content);
  expect(hasOpenOverlay()).toBe(false);
  expect(ignoreShortcut(key("j"))).toBe(false);
  parent.hidden = false;
  expect(hasOpenOverlay()).toBe(true);
  content.remove();
  expect(hasOpenOverlay()).toBe(false);
  expect(ignoreShortcut(key("j"))).toBe(false);
});

test("mod bindings still stay out of text fields, dialogs and menus", () => {
  const input = document.createElement("input");
  const event = key("p", { ctrlKey: true, shiftKey: true });
  input.dispatchEvent(event);
  expect(ignoreShortcut(event)).toBe(true);
  for (const role of ["dialog", "alertdialog", "menu"]) {
    const content = document.body.appendChild(document.createElement("div"));
    content.setAttribute("role", role);
    expect(ignoreShortcut(key("p", { metaKey: true, shiftKey: true }))).toBe(true);
    content.remove();
  }
});

test.each([
  ["1", undefined, "1"],
  ["1", "", "1"],
  ["&", "Digit1", "1"],
  ["¡", "Digit1", "1"],
  ["0", "Digit0", "0"],
  ["9", "Digit9", "9"],
  ["1", "Numpad1", undefined],
  ["1", "KeyA", undefined],
  ["1", "Digit10", undefined],
  ["1", "Digit1\n", undefined],
  ["1\n", "", undefined],
  ["&", "", undefined],
  ["١", "", undefined],
] as const)("physical digit for %s / %s is %s", (key, code, expected) => {
  expect(digitOf({ key, code })).toBe(expected);
});

test.each([
  ["1", "Digit1"],
  ["&", "Digit1"],
  ["¡", "Digit1"],
  ["1", ""],
])("matches and captures modified digit %s / %s", (typed, code) => {
  for (const modifier of ["altKey", "ctrlKey", "metaKey"]) {
    const event = key(typed, { code, [modifier]: true });
    const binding = modifier === "altKey" ? "alt+1" : "mod+1";
    expect(matchesShortcut(event, binding)).toBe(true);
    expect(matchesShortcut(event, "1")).toBe(false);
    expect(matchesShortcut(event, binding.replace("1", "2"))).toBe(false);
    expect(captureShortcut(event)).toEqual({ key: binding });
    expect(ignoreShortcut(event)).toBe(false);
  }
});

test.each([
  { altKey: true, shiftKey: true },
  { altKey: true, ctrlKey: true },
  { altKey: true, metaKey: true },
  { ctrlKey: true, metaKey: true },
  { ctrlKey: true, shiftKey: true },
  { metaKey: true, shiftKey: true },
  { altKey: true, code: "Numpad1" },
  { ctrlKey: true, code: "Numpad1" },
  {},
])("refuses digit jumps with extra modifiers, numpad or no modifier: %j", (options) => {
  const event = key("1", { code: "Digit1", ...options });
  expect(matchesShortcut(event, "alt+1")).toBe(false);
  expect(matchesShortcut(event, "mod+1")).toBe(false);
  if (event.altKey) {
    expect(ignoreShortcut(event)).toBe(true);
    expect(captureShortcut(event)).toEqual({ error: "Alt works only with a digit." });
  } else if (event.ctrlKey || event.metaKey) {
    expect(captureShortcut(event)).toEqual({ error: "Use Ctrl or ⌘ with one letter or digit." });
  }
});

test("Alt digits still respect editable fields, overlays, repeat, composition and prevented events", () => {
  const input = document.createElement("input");
  const event = key("1", { altKey: true, code: "Digit1" });
  input.dispatchEvent(event);
  expect(ignoreShortcut(event)).toBe(true);
  for (const options of [{ repeat: true }, { isComposing: true }, { keyCode: 229 }])
    expect(ignoreShortcut(key("1", { altKey: true, code: "Digit1", ...options }))).toBe(true);
  const prevented = key("1", { altKey: true });
  prevented.preventDefault();
  expect(ignoreShortcut(prevented)).toBe(true);
  for (const role of ["dialog", "alertdialog", "menu"]) {
    const content = document.body.appendChild(document.createElement("div"));
    content.setAttribute("role", role);
    expect(ignoreShortcut(key("1", { altKey: true }))).toBe(true);
    content.remove();
  }
});

test.each([
  ["Linux x86_64", "Alt", "Ctrl", "Alt+1", "Ctrl+1", "Control+1"],
  ["MacIntel", "⌥", "⌘", "⌥1", "⌘1", "Meta+1"],
  ["iPad", "⌥", "⌘", "⌥1", "⌘1", "Meta+1"],
])("digit key labels, caps, badges and ARIA use %s", (platform, alt, mod, altLabel, modLabel, modAria) => {
  expect(keyCaps("alt+1", platform)).toEqual([alt, "1"]);
  expect(keyCaps("mod+1", platform)).toEqual([mod, "1"]);
  expect(keyLabel("alt+1", platform)).toBe(altLabel);
  expect(keyLabel("mod+1", platform)).toBe(modLabel);
  expect(ariaKeyShortcuts("alt+1", platform)).toBe("Alt+1");
  expect(ariaKeyShortcuts("mod+1", platform)).toBe(modAria);
  expect(
    jumpKeysLabel(
      Array.from({ length: 9 }, (_, i) => `alt+${i + 1}`),
      platform,
    ),
  ).toBe(`${altLabel}–9`);
  expect(
    jumpKeysLabel(
      Array.from({ length: 9 }, (_, i) => `mod+${i + 1}`),
      platform,
    ),
  ).toBe(`${modLabel}–9`);
  expect(jumpKeysLabel(Array(9).fill(null), platform)).toBe("Off");
  expect(jumpKeysLabel(["alt+1", null, "mod+1", "j", "k", "l", "/", "?", "9"], platform)).toBe(
    `${altLabel}, Off, ${modLabel}, j, k, l, /, ?, 9`,
  );
  expect(jumpBadge(null, platform)).toBeUndefined();
  expect(jumpBadge("alt+1", platform)).toBe("1");
  expect(jumpBadge("mod+0", platform)).toBe("0");
  expect(jumpBadge("j", platform)).toBe("j");
  expect(jumpBadge("mod+k", platform)).toBe(`${mod}${mod === "Ctrl" ? "+" : ""}K`);
});
