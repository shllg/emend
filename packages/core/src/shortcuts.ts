import { type KeyBinding, type KeySetting, SHORTCUT_DEFAULTS, ShortcutCommand } from "@emend/contract";

interface Candidate {
  value: KeyBinding;
  level: number;
  source: KeySetting["source"];
}

interface CommandState {
  command: ShortcutCommand;
  candidates: Candidate[];
  index: number;
  clashWith: ShortcutCommand | null;
}

function fillTenthJump(keys: Partial<Record<ShortcutCommand, KeyBinding>>) {
  if (Object.hasOwn(keys, "inbox.jump10")) return keys;
  const commands = Array.from({ length: 9 }, (_, index) => `inbox.jump${index + 1}` as ShortcutCommand);
  if (!commands.every((command) => Object.hasOwn(keys, command))) return keys;
  const values = commands.map((command) => keys[command]);
  if (values.every((value) => value === null) || values.every((value, index) => value === `mod+${index + 1}`))
    return { ...keys, "inbox.jump10": null };
  if (values.every((value, index) => value === `alt+${index + 1}`)) return { ...keys, "inbox.jump10": "alt+0" };
  return keys;
}

export function resolveShortcuts({
  file,
  fileErrors,
  overrides,
}: {
  file: Partial<Record<ShortcutCommand, KeyBinding>>;
  fileErrors: ReadonlySet<ShortcutCommand>;
  overrides: Partial<Record<ShortcutCommand, KeyBinding>>;
}): Record<ShortcutCommand, KeySetting> {
  // Groups saved before inbox.jump10 existed keep working as one group.
  overrides = fillTenthJump(overrides);
  if (!fileErrors.has("inbox.jump10")) file = fillTenthJump(file);
  const states: CommandState[] = ShortcutCommand.options.map((command) => {
    const candidates: Candidate[] = [];
    const override = overrides[command],
      fileKey = file[command];
    if (Object.hasOwn(overrides, command) && override !== undefined)
      candidates.push({ value: override, level: 2, source: "override" });
    if (Object.hasOwn(file, command) && fileKey !== undefined)
      candidates.push({ value: fileKey, level: 1, source: "file" });
    candidates.push({ value: SHORTCUT_DEFAULTS[command], level: 0, source: "default" });
    return { command, candidates, index: 0, clashWith: null };
  });

  for (;;) {
    const groups = new Map<string, CommandState[]>();
    for (const state of states) {
      const key = state.candidates[state.index]?.value;
      if (key === null || key === undefined) continue;
      const group = groups.get(key) ?? [];
      group.push(state);
      groups.set(key, group);
    }
    let changed = false;
    for (const group of groups.values()) {
      if (group.length < 2) continue;
      const level = Math.max(...group.map((state) => state.candidates[state.index]?.level ?? 0));
      const leaders = group.filter((state) => state.candidates[state.index]?.level === level);
      for (const state of group) {
        const winner = leaders.find((leader) => leader !== state);
        if (!winner) continue;
        state.clashWith = winner.command;
        state.index++;
        changed = true;
      }
    }
    // Every loss consumes a candidate, so resolution finishes after at most three losses per command.
    if (!changed) break;
  }

  return Object.fromEntries(
    states.map(({ command, candidates, index, clashWith }) => [
      command,
      {
        value: candidates[index]?.value ?? null,
        source: candidates[index]?.source ?? "default",
        default: SHORTCUT_DEFAULTS[command],
        ...(Object.hasOwn(file, command) ? { file: file[command] } : {}),
        ...(Object.hasOwn(overrides, command) ? { override: overrides[command] } : {}),
        fileError: fileErrors.has(command),
        clashWith,
      },
    ]),
  ) as Record<ShortcutCommand, KeySetting>;
}
