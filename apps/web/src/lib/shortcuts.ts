import { type KeyBinding, SHORTCUT_DEFAULTS, type ShortcutCommand } from "@emend/contract";

export const shortcutCommands = Object.keys(SHORTCUT_DEFAULTS) as ShortcutCommand[];
export const jumpCommands: ShortcutCommand[] = [
  "inbox.jump1",
  "inbox.jump2",
  "inbox.jump3",
  "inbox.jump4",
  "inbox.jump5",
  "inbox.jump6",
  "inbox.jump7",
  "inbox.jump8",
  "inbox.jump9",
  "inbox.jump10",
];
export const jumpGroupLabel = "Open inbox row 1 to 10";

export function jumpKey(modifier: "alt" | "mod", index: number) {
  return `${modifier}+${(index + 1) % 10}`;
}

export const shortcutLabels: Record<ShortcutCommand, string> = {
  "inbox.next": "Next review or pub",
  "inbox.previous": "Previous review or pub",
  "inbox.filter": "Switch the inbox filter",
  "inbox.search": "Search the inbox",
  "inbox.back": "Back to the inbox",
  "inbox.jump1": "Open inbox row 1",
  "inbox.jump2": "Open inbox row 2",
  "inbox.jump3": "Open inbox row 3",
  "inbox.jump4": "Open inbox row 4",
  "inbox.jump5": "Open inbox row 5",
  "inbox.jump6": "Open inbox row 6",
  "inbox.jump7": "Open inbox row 7",
  "inbox.jump8": "Open inbox row 8",
  "inbox.jump9": "Open inbox row 9",
  "inbox.jump10": "Open inbox row 10",
  "tab.writeup": "Writeup tab",
  "tab.files": "Files tab",
  "tab.docs": "Docs tab",
  "tab.comments": "Comments tab",
  "tab.diff": "Diff tab",
  "file.next": "Next file",
  "file.previous": "Previous file",
  "file.toggleViewed": "Mark the current file viewed or not viewed",
  "thread.next": "Next comment",
  "thread.previous": "Previous comment",
  "review.instructions": "Write the Send instructions",
  "review.approve": "Approve",
  "review.snooze": "Snooze",
  "review.pin": "Pin or unpin the review",
  "shortcuts.show": "Show keyboard shortcuts",
  "palette.open": "Open the command palette",
};
export const shortcutGroups = [
  {
    label: "Inbox",
    commands: shortcutCommands.filter((command) => command.startsWith("inbox.") && !jumpCommands.includes(command)),
    jump: true,
  },
  {
    label: "Review page",
    commands: shortcutCommands.filter((command) => /^(tab|file|thread|review)\./.test(command)),
  },
  { label: "Everywhere", commands: ["shortcuts.show", "palette.open"] as ShortcutCommand[] },
];

export function keyCaps(key: string, platform = navigator.platform): string[] {
  const mac = /Mac|iPhone|iPad|iPod/.test(platform);
  if (key.startsWith("alt+")) return [mac ? "⌥" : "Alt", key.slice(-1)];
  if (key.startsWith("mod+"))
    return [
      mac ? "⌘" : "Ctrl",
      ...(key.startsWith("mod+shift+") ? [mac ? "⇧" : "Shift"] : []),
      key.slice(-1).toUpperCase(),
    ];
  if (key.startsWith("shift+")) return [mac ? "⇧" : "Shift", key.slice(6).toUpperCase()];
  return [key];
}

export function keyLabel(key: KeyBinding, platform = navigator.platform) {
  if (key === null) return "Off";
  return keyCaps(key, platform).join(/Mac|iPhone|iPad|iPod/.test(platform) ? "" : "+");
}

export function ariaKeyShortcuts(key: string, platform = navigator.platform): string {
  return keyCaps(key, platform)
    .map((cap) => {
      switch (cap) {
        case "Ctrl":
          return "Control";
        case "⌘":
          return "Meta";
        case "⌥":
          return "Alt";
        case "⇧":
          return "Shift";
        case "+":
          return "Plus";
        default:
          return /^[a-z]$/.test(cap) ? cap.toUpperCase() : cap;
      }
    })
    .join("+");
}

type KeyEvent = Pick<KeyboardEvent, "key" | "shiftKey" | "ctrlKey" | "metaKey" | "altKey"> & {
  code?: string;
  getModifierState?: (key: "AltGraph") => boolean;
};

export function digitOf(event: Pick<KeyEvent, "key" | "code">): string | undefined {
  if (event.code) return event.code.length === 6 && /^Digit[0-9]$/.test(event.code) ? event.code.slice(-1) : undefined;
  return event.key.length === 1 && /^[0-9]$/.test(event.key) ? event.key : undefined;
}

function altGraph(event: KeyEvent) {
  return event.getModifierState?.("AltGraph") === true;
}

function altDigit(event: KeyEvent) {
  return event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && digitOf(event) !== undefined;
}
export function matchesShortcut(event: KeyEvent, key: KeyBinding) {
  if (key === null) return false;
  if (/^alt\+[0-9]$/.test(key)) return altDigit(event) && digitOf(event) === key.slice(-1);
  if (event.altKey) return false;
  if (/^mod\+[0-9]$/.test(key))
    return event.ctrlKey !== event.metaKey && !event.shiftKey && !altGraph(event) && digitOf(event) === key.slice(-1);
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
  if (event.altKey)
    return altDigit(event) ? { key: `alt+${digitOf(event)}` } : { error: "Alt works only with a digit." };
  if (event.ctrlKey || event.metaKey) {
    if (event.ctrlKey !== event.metaKey && !event.shiftKey && !altGraph(event) && digitOf(event) !== undefined)
      return { key: `mod+${digitOf(event)}` };
    if (event.ctrlKey === event.metaKey || !/^[a-z]$/i.test(event.key))
      return { error: "Use Ctrl or ⌘ with one letter or digit." };
    return { key: `mod+${event.shiftKey ? "shift+" : ""}${event.key.toLowerCase()}` };
  }
  if (!/^[!-~]$/.test(event.key)) return { error: "Use a letter, a digit or a punctuation key." };
  return {
    key: /^[a-z]$/i.test(event.key) ? `${event.shiftKey ? "shift+" : ""}${event.key.toLowerCase()}` : event.key,
  };
}

export function ignoreShortcut(event: KeyboardEvent, { allowRepeat = false }: { allowRepeat?: boolean } = {}) {
  if (
    event.defaultPrevented ||
    (event.repeat && !allowRepeat) ||
    event.isComposing ||
    event.keyCode === 229 ||
    (event.altKey && !altDigit(event))
  )
    return true;
  // Shortcuts stay out of editable controls, including shadow roots. Frame events never reach here.
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
  return hasOpenOverlay();
}

export function hasOpenOverlay() {
  // Radix unmounts closed content; during exit animations it carries data-state="closed".
  return [...document.querySelectorAll('[role="dialog"], [role="alertdialog"], [role="menu"]')].some(
    (content) =>
      content.getAttribute("data-state") !== "closed" &&
      !content.closest("[hidden]") &&
      !content.hasAttribute("data-reading-thread-popover"),
  );
}

export function jumpKeysLabel(values: KeyBinding[], platform = navigator.platform): string {
  if (values.every((value) => value === null)) return "Off";
  for (const modifier of ["alt", "mod"]) {
    if (values.length === 10 && values.slice(0, 9).every((value, index) => value === `${modifier}+${index + 1}`)) {
      const range = keyLabel(`${modifier}+1`, platform).replace(/1$/, "1–9");
      const tenth = values[9];
      return tenth == null ? range : `${range}, ${keyLabel(tenth, platform)}`;
    }
  }
  return values.map((value) => keyLabel(value, platform)).join(", ");
}

export function jumpBadge(key: KeyBinding, platform = navigator.platform): string | undefined {
  if (key === null) return undefined;
  return /^(alt|mod)\+[0-9]$/.test(key) ? key.slice(-1) : keyLabel(key, platform);
}
