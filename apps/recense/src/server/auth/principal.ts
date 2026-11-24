import type { Scope, TokenKind } from "@recense/contract";
import type { Context } from "hono";
import { ApiError } from "../http/errors.ts";

export interface Principal {
  ownerId: string;
  tokenId: string;
  kind: TokenKind;
  instanceId: string | null;
  scopes: Scope[];
}
export type AppEnv = {
  Bindings: { onResponseSent?: (callback: () => void) => void };
  Variables: { principal: Principal; jsonBody: string };
};
export function requireScope(c: Context<AppEnv>, scope: Scope): void {
  if (!c.get("principal").scopes.includes(scope)) throw new ApiError("forbidden");
}
