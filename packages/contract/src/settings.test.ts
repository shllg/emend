import { expect, test } from "vitest";
import {
  ApprovedActiveHours,
  HoursSetting,
  InboxList,
  MAX_APPROVED_ACTIVE_HOURS,
  SCOPES_BY_KIND,
  SettingSource,
  SettingsUpdate,
  SettingsView,
} from "./index.ts";

test("whole approved hours include both bounds", () => {
  expect(MAX_APPROVED_ACTIVE_HOURS).toBe(720);
  for (const value of [0, 1, 12, 720]) {
    expect(ApprovedActiveHours.parse(value)).toBe(value);
    expect(SettingsUpdate.parse({ approvedActiveHours: value })).toEqual({ approvedActiveHours: value });
  }
  expect(SettingsUpdate.parse({ approvedActiveHours: null })).toEqual({ approvedActiveHours: null });
});
test("updates reject invalid hours, omissions and unknown keys", () => {
  for (const value of [-1, 721, 1.5, "3", true, undefined, NaN, Infinity]) {
    expect(ApprovedActiveHours.safeParse(value).success).toBe(false);
    expect(SettingsUpdate.safeParse({ approvedActiveHours: value }).success).toBe(false);
  }
  expect(SettingsUpdate.safeParse({ approvedActiveHours: 12, other: true }).success).toBe(false);
});
test("settings expose the source and nullable file and override", () => {
  for (const source of SettingSource.options) {
    const setting = { value: 12, source, default: 12, file: null, override: null, fileError: false };
    expect(SettingsView.parse({ approvedActiveHours: setting })).toEqual({ approvedActiveHours: setting });
    expect(HoursSetting.safeParse({ ...setting, source: "browser" }).success).toBe(false);
    expect(HoursSetting.safeParse({ ...setting, file: 25.5 }).success).toBe(false);
    expect(HoursSetting.safeParse({ ...setting, override: "12" }).success).toBe(false);
    expect(HoursSetting.safeParse({ ...setting, fileError: undefined }).success).toBe(false);
  }
});
test("only reviewers manage settings", () => {
  for (const [kind, scopes] of Object.entries(SCOPES_BY_KIND))
    expect(scopes.some((scope) => scope === "settings:manage")).toBe(kind === "reviewer");
});
test("inbox lists require the window used for their items", () => {
  const list = { items: [], serverTime: "2026-11-04T10:00:00.000Z" };
  expect(InboxList.safeParse(list).success).toBe(false);
  for (const approvedActiveHours of [0, 720])
    expect(InboxList.parse({ ...list, approvedActiveHours }).approvedActiveHours).toBe(approvedActiveHours);
});
