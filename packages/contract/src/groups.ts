import { z } from "zod";
import { LIMITS } from "./limits.ts";

export const GroupName = z
  .string()
  .refine((name) => !/[\p{Cc}\u2028\u2029]/u.test(name), "name must be single-line text")
  .refine((name) => !/[\u202a-\u202e\u2066-\u2069]/u.test(name), "name must not contain bidi controls")
  .trim()
  .min(1)
  .max(LIMITS.groupNameChars);
export type GroupName = z.infer<typeof GroupName>;
export const InboxGroup = z.object({ id: z.uuid(), name: GroupName });
export type InboxGroup = z.infer<typeof InboxGroup>;
export const InboxListGroup = InboxGroup.extend({ members: z.int().nonnegative() });
export type InboxListGroup = z.infer<typeof InboxListGroup>;
export const GroupRequest = z.strictObject({ name: GroupName });
export type GroupRequest = z.infer<typeof GroupRequest>;
export const ReviewGroupRequest = z.strictObject({ groupId: z.uuid().nullable() });
export type ReviewGroupRequest = z.infer<typeof ReviewGroupRequest>;
export const REVIEW_GROUPS_FEATURE = "review-groups";
