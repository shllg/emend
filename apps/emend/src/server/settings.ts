import { lstat } from "node:fs/promises";
import { APPROVED_ACTIVE_HOURS, ApprovedActiveHours, type SettingsView } from "@emend/contract";
import { and, eq } from "drizzle-orm";
import type { Queries } from "../db/client.ts";
import { settings } from "../db/schema.ts";
import { readConfigJson } from "../state/read-config.ts";

async function fileSetting(configFile?: string): Promise<{ file: number | null; fileError: boolean }> {
  if (!configFile) return { file: null, fileError: false };
  try {
    const document = await readConfigJson(configFile);
    if (!document || typeof document !== "object" || Array.isArray(document)) return { file: null, fileError: true };
    if (!Object.hasOwn(document, "approvedActiveHours")) return { file: null, fileError: false };
    const parsed = ApprovedActiveHours.safeParse((document as Record<string, unknown>).approvedActiveHours);
    return { file: parsed.success ? parsed.data : null, fileError: !parsed.success };
  } catch (error) {
    // An existing dangling link is an unusable file, not a missing config.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      const missing = await lstat(configFile).then(
        () => false,
        (error: NodeJS.ErrnoException) => error.code === "ENOENT",
      );
      if (missing) return { file: null, fileError: false };
    }
    return { file: null, fileError: true };
  }
}

export async function readSettings(ownerId: string, q: Queries, configFile?: string): Promise<SettingsView> {
  const { file, fileError } = await fileSetting(configFile);
  const row = await q
    .select()
    .from(settings)
    .where(and(eq(settings.ownerId, ownerId), eq(settings.key, "approvedActiveHours")))
    .get();
  let override: number | null = null;
  if (row) {
    try {
      override = ApprovedActiveHours.safeParse(JSON.parse(row.value)).data ?? null;
    } catch {
      // Corrupt or obsolete stored values do not override a usable file or default.
    }
  }
  return {
    approvedActiveHours: {
      value: override ?? file ?? APPROVED_ACTIVE_HOURS,
      source: override !== null ? "override" : file !== null ? "file" : "default",
      default: APPROVED_ACTIVE_HOURS,
      file,
      override,
      fileError,
    },
  };
}

export async function updateApprovedActiveHours(ownerId: string, q: Queries, value: number | null, now: number) {
  if (value === null) {
    await q.delete(settings).where(and(eq(settings.ownerId, ownerId), eq(settings.key, "approvedActiveHours")));
  } else {
    await q
      .insert(settings)
      .values({ ownerId, key: "approvedActiveHours", value: JSON.stringify(value), updatedAt: now })
      .onConflictDoUpdate({
        target: [settings.ownerId, settings.key],
        set: { value: JSON.stringify(value), updatedAt: now },
        setWhere: eq(settings.ownerId, ownerId),
      });
  }
}
