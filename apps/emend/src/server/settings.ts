import { lstat } from "node:fs/promises";
import {
  APPROVED_ACTIVE_HOURS,
  APPROVED_ACTIVE_LIMIT,
  ApprovedActiveHours,
  ApprovedActiveLimit,
  type HoursSetting,
  KeyBinding,
  type KeysSetting,
  normalizeShortcutKey,
  type SettingsUpdate,
  type SettingsView,
  ShortcutCommand,
} from "@emend/contract";
import { resolveShortcuts } from "@emend/core";
import { and, eq, inArray } from "drizzle-orm";
import type { Queries } from "../db/client.ts";
import { settings } from "../db/schema.ts";
import { readConfigJson } from "../state/read-config.ts";

export interface FileSetting {
  file: number | null;
  fileError: boolean;
  limit: { file: number | null; fileError: boolean };
  keys: {
    file: Partial<Record<ShortcutCommand, KeyBinding>>;
    fileErrors: Set<ShortcutCommand>;
    fileError: boolean;
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export async function readFileSetting(configFile?: string): Promise<FileSetting> {
  const result: FileSetting = {
    file: null,
    fileError: false,
    limit: { file: null, fileError: false },
    keys: { file: {}, fileErrors: new Set(), fileError: false },
  };
  if (!configFile) return result;
  try {
    const document = await readConfigJson(configFile);
    if (!isPlainObject(document)) throw new Error("Invalid config object");
    if (Object.hasOwn(document, "approvedActiveHours")) {
      const parsed = ApprovedActiveHours.safeParse(document.approvedActiveHours);
      result.file = parsed.success ? parsed.data : null;
      result.fileError = !parsed.success;
    }
    if (Object.hasOwn(document, "approvedActiveLimit")) {
      const parsed = ApprovedActiveLimit.safeParse(document.approvedActiveLimit);
      result.limit.file = parsed.success ? parsed.data : null;
      result.limit.fileError = !parsed.success;
    }
    if (Object.hasOwn(document, "keys")) {
      if (!isPlainObject(document.keys)) result.keys.fileError = true;
      else
        for (const [id, value] of Object.entries(document.keys)) {
          const command = ShortcutCommand.safeParse(id);
          if (!command.success) {
            result.keys.fileError = true;
            continue;
          }
          const key = value === null ? null : normalizeShortcutKey(value);
          if (key === undefined) result.keys.fileErrors.add(command.data);
          else result.keys.file[command.data] = key;
        }
    }
    return result;
  } catch (error) {
    // An existing dangling link is an unusable file, not a missing config.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      const missing = await lstat(configFile).then(
        () => false,
        (error: NodeJS.ErrnoException) => error.code === "ENOENT",
      );
      if (missing) return result;
    }
    result.fileError = true;
    result.limit.fileError = true;
    result.keys.fileError = true;
    return result;
  }
}

export async function readSettings(
  ownerId: string,
  q: Queries,
  file: FileSetting,
): Promise<Pick<SettingsView, "approvedActiveHours" | "approvedActiveLimit">> {
  const rows = await q
    .select()
    .from(settings)
    .where(and(eq(settings.ownerId, ownerId), inArray(settings.key, ["approvedActiveHours", "approvedActiveLimit"])))
    .all();
  function resolve(
    key: "approvedActiveHours" | "approvedActiveLimit",
    schema: typeof ApprovedActiveHours,
    fallback: number,
    { file, fileError }: { file: number | null; fileError: boolean },
  ): HoursSetting {
    const row = rows.find((row) => row.key === key);
    let override: number | null = null;
    if (row) {
      try {
        override = schema.safeParse(JSON.parse(row.value)).data ?? null;
      } catch {
        // Corrupt or obsolete stored values do not override a usable file or default.
      }
    }
    return {
      value: override ?? file ?? fallback,
      source: override !== null ? "override" : file !== null ? "file" : "default",
      default: fallback,
      file,
      override,
      fileError,
    };
  }
  return {
    approvedActiveHours: resolve("approvedActiveHours", ApprovedActiveHours, APPROVED_ACTIVE_HOURS, file),
    approvedActiveLimit: resolve("approvedActiveLimit", ApprovedActiveLimit, APPROVED_ACTIVE_LIMIT, file.limit),
  };
}

async function readKeyOverrides(ownerId: string, q: Queries): Promise<Partial<Record<ShortcutCommand, KeyBinding>>> {
  const row = await q
    .select()
    .from(settings)
    .where(and(eq(settings.ownerId, ownerId), eq(settings.key, "keys")))
    .get();
  const overrides: Partial<Record<ShortcutCommand, KeyBinding>> = {};
  if (row) {
    try {
      const stored: unknown = JSON.parse(row.value);
      if (isPlainObject(stored))
        for (const command of ShortcutCommand.options) {
          if (!Object.hasOwn(stored, command)) continue;
          const key = KeyBinding.safeParse(stored[command]);
          if (key.success) overrides[command] = key.data;
        }
    } catch {
      // Corrupt stored values do not override a usable file or default.
    }
  }
  return overrides;
}

export async function readKeySettings(ownerId: string, q: Queries, file: FileSetting): Promise<KeysSetting> {
  return {
    commands: resolveShortcuts({ ...file.keys, overrides: await readKeyOverrides(ownerId, q) }),
    fileError: file.keys.fileError,
  };
}

export async function updateKeys(
  ownerId: string,
  q: Queries,
  updates: NonNullable<SettingsUpdate["keys"]>,
  now: number,
) {
  const overrides = await readKeyOverrides(ownerId, q);
  for (const command of ShortcutCommand.options) {
    const update = updates[command];
    if (update === undefined) continue;
    if (update === null) delete overrides[command];
    else overrides[command] = update.key;
  }
  if (!Object.keys(overrides).length) {
    await q.delete(settings).where(and(eq(settings.ownerId, ownerId), eq(settings.key, "keys")));
  } else {
    const value = JSON.stringify(overrides);
    await q
      .insert(settings)
      .values({ ownerId, key: "keys", value, updatedAt: now })
      .onConflictDoUpdate({
        target: [settings.ownerId, settings.key],
        set: { value, updatedAt: now },
        setWhere: eq(settings.ownerId, ownerId),
      });
  }
}

export async function updateNumericSetting(
  ownerId: string,
  q: Queries,
  key: "approvedActiveHours" | "approvedActiveLimit",
  value: number | null,
  now: number,
) {
  if (value === null) {
    await q.delete(settings).where(and(eq(settings.ownerId, ownerId), eq(settings.key, key)));
  } else {
    await q
      .insert(settings)
      .values({ ownerId, key, value: JSON.stringify(value), updatedAt: now })
      .onConflictDoUpdate({
        target: [settings.ownerId, settings.key],
        set: { value: JSON.stringify(value), updatedAt: now },
        setWhere: eq(settings.ownerId, ownerId),
      });
  }
}
