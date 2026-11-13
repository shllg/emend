import { afterEach, expect, test } from "vitest";
import { captureShortcut, ignoreShortcut, keyLabel, matchesShortcut } from "./shortcuts.ts";

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
  "Alt combinations never match or capture (%j)",
  (options) => {
    const event = key("k", options);
    for (const binding of ["k", "mod+k", "mod+shift+k"]) expect(matchesShortcut(event, binding)).toBe(false);
    expect(ignoreShortcut(event)).toBe(true);
    expect(captureShortcut(event)).toEqual({ error: "Alt combinations stay with the browser." });
  },
);
test.each([
  ["1", { ctrlKey: true }],
  ["?", { metaKey: true }],
  ["Enter", { ctrlKey: true }],
  ["k", { ctrlKey: true, metaKey: true }],
  ["é", { metaKey: true }],
] as const)("refuses mod capture for %s (%j)", (typed, options) => {
  expect(captureShortcut(key(typed, options))).toEqual({ error: "Use Ctrl or ⌘ with one letter." });
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
  expect(ignoreShortcut(key("j"))).toBe(true);
  content.setAttribute("data-state", "closed");
  expect(ignoreShortcut(key("j"))).toBe(false);
  content.setAttribute("data-state", "open");
  content.hidden = true;
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
