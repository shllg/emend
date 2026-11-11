import { z } from "zod";

export const MAX_APPROVED_ACTIVE_HOURS = 720;
export const ApprovedActiveHours = z.int().min(0).max(MAX_APPROVED_ACTIVE_HOURS);
export type ApprovedActiveHours = z.infer<typeof ApprovedActiveHours>;

export const SettingSource = z.enum(["default", "file", "override"]);
export type SettingSource = z.infer<typeof SettingSource>;

export const HoursSetting = z.object({
  value: ApprovedActiveHours,
  source: SettingSource,
  default: ApprovedActiveHours,
  file: ApprovedActiveHours.nullable(),
  override: ApprovedActiveHours.nullable(),
  fileError: z.boolean(),
});
export type HoursSetting = z.infer<typeof HoursSetting>;

export const SettingsView = z.object({ approvedActiveHours: HoursSetting });
export type SettingsView = z.infer<typeof SettingsView>;

export const SettingsUpdate = z.strictObject({ approvedActiveHours: ApprovedActiveHours.nullable() });
export type SettingsUpdate = z.infer<typeof SettingsUpdate>;
