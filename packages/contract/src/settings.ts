import { z } from "zod";
import { LIMITS } from "./limits.ts";

export const MAX_APPROVED_ACTIVE_HOURS = 720;
export const ApprovedActiveHours = z.int().min(0).max(MAX_APPROVED_ACTIVE_HOURS);
export type ApprovedActiveHours = z.infer<typeof ApprovedActiveHours>;

export const MAX_APPROVED_ACTIVE_LIMIT = LIMITS.inboxItems;
export const ApprovedActiveLimit = z.int().min(0).max(MAX_APPROVED_ACTIVE_LIMIT);
export type ApprovedActiveLimit = z.infer<typeof ApprovedActiveLimit>;

export const SettingSource = z.enum(["default", "file", "override"]);
export type SettingSource = z.infer<typeof SettingSource>;

export const SHORTCUT_DEFAULTS = {
  "inbox.next": "j",
  "inbox.previous": "k",
  "inbox.filter": "f",
  "inbox.search": "/",
  "inbox.back": "u",
  "tab.writeup": "1",
  "tab.files": "2",
  "tab.docs": "3",
  "tab.comments": "4",
  "tab.diff": "5",
  "file.next": "n",
  "file.previous": "p",
  "file.toggleViewed": "v",
  "thread.next": ".",
  "thread.previous": ",",
  "review.instructions": "s",
  "review.approve": "shift+a",
  "review.snooze": "z",
  "shortcuts.show": "?",
  "palette.open": "mod+shift+p",
} as const;

export const ShortcutCommand = z.enum([
  "inbox.next",
  "inbox.previous",
  "inbox.filter",
  "inbox.search",
  "inbox.back",
  "tab.writeup",
  "tab.files",
  "tab.docs",
  "tab.comments",
  "tab.diff",
  "file.next",
  "file.previous",
  "file.toggleViewed",
  "thread.next",
  "thread.previous",
  "review.instructions",
  "review.approve",
  "review.snooze",
  "shortcuts.show",
  "palette.open",
]);
export type ShortcutCommand = z.infer<typeof ShortcutCommand>;

export const ShortcutKey = z
  .string()
  .refine(
    (key) =>
      (key.length === 1 && key >= "!" && key <= "~" && !/[A-Z]/.test(key)) ||
      (key.length === 7 && /^shift\+[a-z]$/.test(key)) ||
      ((key.length === 5 || key.length === 11) && /^mod\+(shift\+)?[a-z]$/.test(key)),
    "Invalid shortcut key",
  );
export type ShortcutKey = z.infer<typeof ShortcutKey>;

export function normalizeShortcutKey(input: unknown): ShortcutKey | undefined {
  const parsed = ShortcutKey.safeParse(input);
  if (parsed.success) return parsed.data;
  if (typeof input !== "string") return undefined;
  if (input.length === 1 && /^[A-Z]$/.test(input)) return `shift+${input.toLowerCase()}`;
  if (input.length === 7 && /^shift\+[a-z]$/i.test(input)) return input.toLowerCase();
  if ((input.length === 5 || input.length === 11) && /^mod\+(shift\+)?[a-z]$/i.test(input)) return input.toLowerCase();
  return undefined;
}

export const KeyBinding = ShortcutKey.nullable();
export type KeyBinding = z.infer<typeof KeyBinding>;

export const KeySetting = z.object({
  value: KeyBinding,
  source: SettingSource,
  default: ShortcutKey,
  file: KeyBinding.optional(),
  override: KeyBinding.optional(),
  fileError: z.boolean(),
  clashWith: ShortcutCommand.nullable(),
});
export type KeySetting = z.infer<typeof KeySetting>;

export const KeysSetting = z.object({ commands: z.record(ShortcutCommand, KeySetting), fileError: z.boolean() });
export type KeysSetting = z.infer<typeof KeysSetting>;

export const HoursSetting = z.object({
  value: ApprovedActiveHours,
  source: SettingSource,
  default: ApprovedActiveHours,
  file: ApprovedActiveHours.nullable(),
  override: ApprovedActiveHours.nullable(),
  fileError: z.boolean(),
});
export type HoursSetting = z.infer<typeof HoursSetting>;

export const LimitSetting = z.object({
  value: ApprovedActiveLimit,
  source: SettingSource,
  default: ApprovedActiveLimit,
  file: ApprovedActiveLimit.nullable(),
  override: ApprovedActiveLimit.nullable(),
  fileError: z.boolean(),
});
export type LimitSetting = z.infer<typeof LimitSetting>;

export const SettingsView = z.object({
  approvedActiveHours: HoursSetting,
  approvedActiveLimit: LimitSetting,
  keys: KeysSetting,
  serverTime: z.iso.datetime(),
});
export type SettingsView = z.infer<typeof SettingsView>;

export const SettingsUpdate = z.strictObject({
  approvedActiveHours: ApprovedActiveHours.nullable().optional(),
  approvedActiveLimit: ApprovedActiveLimit.nullable().optional(),
  keys: z.partialRecord(ShortcutCommand, z.strictObject({ key: KeyBinding }).nullable()).optional(),
});
export type SettingsUpdate = z.infer<typeof SettingsUpdate>;
