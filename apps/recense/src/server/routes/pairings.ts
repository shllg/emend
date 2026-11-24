import { PairingCreated, PairingRequest } from "@recense/contract";
import type { Hono } from "hono";
import type { AppDeps } from "../app.ts";
import { createPairing } from "../auth/pairings.ts";
import type { AppEnv } from "../auth/principal.ts";
import { parseBody } from "../http/body.ts";
export function pairingRoutes(app: Hono<AppEnv>, deps: AppDeps) {
  app.post("/api/v1/pairings", async (c) => {
    const { purpose } = parseBody(c, PairingRequest);
    const pairing = await createPairing(deps.db, c.get("principal"), deps.now(), purpose);
    const url = new URL("/pair", deps.config.baseUrl);
    url.hash = pairing.secret;
    return c.json(
      PairingCreated.parse({ url: url.href, code: pairing.code, expiresAt: new Date(pairing.expiresAt).toISOString() }),
      201,
    );
  });
}
