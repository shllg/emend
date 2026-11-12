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
test.each(["ctrlKey", "metaKey", "altKey"])("%s never matches and capture refuses it", (modifier) => {
  const event = key("k", { [modifier]: true });
  expect(matchesShortcut(event, "k")).toBe(false);
  expect(ignoreShortcut(event)).toBe(true);
  expect(captureShortcut(event)).toEqual({ error: "Ctrl, ⌘ and Alt combinations stay with the browser." });
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
