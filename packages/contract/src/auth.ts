import { z } from "zod";

export const TokenKind = z.enum(["admin", "agent", "reviewer"]);
export type TokenKind = z.infer<typeof TokenKind>;

export const Scope = z.enum([
  "pairings:create",
  "devices:manage",
  "settings:manage",
  "server:stop",
  "publish",
  "take",
  "reply",
  "read",
  "comment",
  "send",
]);
export type Scope = z.infer<typeof Scope>;

export const SCOPES_BY_KIND = {
  admin: ["pairings:create", "devices:manage", "server:stop"],
  agent: ["publish", "take", "reply"],
  reviewer: ["read", "comment", "send", "pairings:create", "devices:manage", "settings:manage"],
} as const satisfies Record<TokenKind, readonly Scope[]>;
