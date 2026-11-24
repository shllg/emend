import { SessionRequest } from "@recense/contract";
import type { Hono } from "hono";
import type { AppDeps } from "../app.ts";
import { type pairingRedemptions, redeemPairing } from "../auth/pairings.ts";
import type { AppEnv } from "../auth/principal.ts";
import {
  expireLegacySessionCookie,
  revokeSession,
  secureSessionRequest,
  writeSessionCookie,
} from "../auth/sessions.ts";
import { parseBody } from "../http/body.ts";
export function sessionRoutes(app: Hono<AppEnv>, deps: AppDeps, redemptions: ReturnType<typeof pairingRedemptions>) {
  app.post("/api/v1/session", async (c) => {
    const input = parseBody(c, SessionRequest);
    const token = await redemptions(input.code !== undefined, (now) =>
      redeemPairing(deps.db, input, now, c.req.header("User-Agent")),
    );
    writeSessionCookie(c, token.secret, secureSessionRequest(c, deps.config.secureCookieHost));
    return c.body(null, 204);
  });
  app.delete("/api/v1/session", async (c) => {
    const principal = c.get("principal");
    const revoked = await revokeSession(deps.db, principal, deps.now());
    for (const token of revoked) deps.events?.closeSession(principal.ownerId, token.id);
    const secure = secureSessionRequest(c, deps.config.secureCookieHost);
    writeSessionCookie(c, "", secure, true);
    expireLegacySessionCookie(c, secure);
    return c.body(null, 204);
  });
}
