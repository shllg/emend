import { type KeyBinding, SHORTCUT_DEFAULTS, type ShortcutCommand } from "@emend/contract";

export const shortcutCommands = Object.keys(SHORTCUT_DEFAULTS) as ShortcutCommand[];
export const shortcutLabels: Record<ShortcutCommand, string> = {
  "inbox.next": "Next review or pub",
  "inbox.previous": "Previous review or pub",
  "inbox.filter": "Switch the inbox filter",
  "inbox.search": "Search the inbox",
  "inbox.back": "Back to the inbox",
  "tab.writeup": "Writeup tab",
  "tab.files": "Files tab",
  "tab.docs": "Docs tab",
  "tab.comments": "Comments tab",
  "tab.diff": "Diff tab",
  "file.next": "Next file",
  "file.previous": "Previous file",
  "file.toggleViewed": "Mark the current file viewed or not viewed",
  "review.instructions": "Write the Send instructions",
  "review.approve": "Approve",
  "review.snooze": "Snooze",
  "shortcuts.show": "Show keyboard shortcuts",
  "palette.open": "Open the command palette",
};
export const shortcutGroups = [
  { label: "Inbox", commands: shortcutCommands.filter((command) => command.startsWith("inbox.")) },
  {
    label: "Review page",
    commands: shortcutCommands.filter((command) => /^(tab|file|review)\./.test(command)),
  },
  { label: "Everywhere", commands: ["shortcuts.show", "palette.open"] as ShortcutCommand[] },
];

export function keyLabel(key: KeyBinding, platform = navigator.platform) {
  if (key === null) return "Off";
  const mac = /Mac|iPhone|iPad|iPod/.test(platform);
  if (key.startsWith("mod+"))
    return `${mac ? "⌘" : "Ctrl+"}${key.startsWith("mod+shift+") ? (mac ? "⇧" : "Shift+") : ""}${key.slice(-1).toUpperCase()}`;
  if (key.startsWith("shift+")) return `${mac ? "⇧" : "Shift+"}${key.slice(6).toUpperCase()}`;
  return key;
}

type KeyEvent = Pick<KeyboardEvent, "key" | "shiftKey" | "ctrlKey" | "metaKey" | "altKey">;
export function matchesShortcut(event: KeyEvent, key: KeyBinding) {
  if (key === null || event.altKey) return false;
  if (key.startsWith("mod+"))
    return (
      event.ctrlKey !== event.metaKey &&
      event.shiftKey === key.startsWith("mod+shift+") &&
      event.key.toLowerCase() === key.slice(-1)
    );
  if (event.ctrlKey || event.metaKey) return false;
  if (/^(shift\+)?[a-z]$/.test(key))
    return event.key.toLowerCase() === key.slice(-1) && event.shiftKey === key.startsWith("shift+");
  return event.key === key;
}

export function captureShortcut(event: KeyEvent): { key?: string; error?: string } {
  if (["Shift", "Control", "Meta", "Alt", "AltGraph"].includes(event.key)) return {};
  if (event.altKey) return { error: "Alt combinations stay with the browser." };
  if (event.ctrlKey || event.metaKey) {
    if (event.ctrlKey === event.metaKey || !/^[a-z]$/i.test(event.key))
      return { error: "Use Ctrl or ⌘ with one letter." };
    return { key: `mod+${event.shiftKey ? "shift+" : ""}${event.key.toLowerCase()}` };
  }
  if (!/^[!-~]$/.test(event.key)) return { error: "Use a letter, a digit or a punctuation key." };
  return {
    key: /^[a-z]$/i.test(event.key) ? `${event.shiftKey ? "shift+" : ""}${event.key.toLowerCase()}` : event.key,
  };
}

export function ignoreShortcut(event: KeyboardEvent) {
  if (event.defaultPrevented || event.repeat || event.isComposing || event.keyCode === 229 || event.altKey) return true;
  // Plain and mod keys both stay out of editable controls, including shadow roots. Frame events never reach here.
  const target = event.composedPath()[0] ?? event.target;
  if (target instanceof Element) {
    if (target.closest("textarea, select")) return true;
    const editable = target.closest("[contenteditable]");
    if (editable && editable.getAttribute("contenteditable") !== "false") return true;
    if (
      target instanceof HTMLInputElement &&
      !["checkbox", "radio", "button", "submit", "reset", "range", "color", "file", "image"].includes(target.type)
    )
      return true;
  }
  // Radix unmounts closed content; during exit animations it carries data-state="closed".
  return [...document.querySelectorAll('[role="dialog"], [role="alertdialog"], [role="menu"]')].some(
    (content) => content.getAttribute("data-state") !== "closed" && !content.closest("[hidden]"),
  );
}
