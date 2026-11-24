import { MachineRegistered, MachineRegistration } from "@recense/contract";
import type { Hono } from "hono";
import type { AppDeps } from "../app.ts";
import { detachMachine, registerMachine } from "../auth/machines.ts";
import type { pairingRedemptions } from "../auth/pairings.ts";
import type { AppEnv } from "../auth/principal.ts";
import { parseBody } from "../http/body.ts";

export function machineRoutes(app: Hono<AppEnv>, deps: AppDeps, redemptions: ReturnType<typeof pairingRedemptions>) {
  app.post("/api/v1/machines", async (c) => {
    const input = parseBody(c, MachineRegistration);
    const token = await redemptions(input.code !== undefined, (now) =>
      registerMachine(deps.db, input, deps.instance, now),
    );
    return c.json(
      MachineRegistered.parse({ token: token.secret, hub: { ...deps.instance, url: deps.config.baseUrl } }),
      201,
    );
  });
  app.delete("/api/v1/machines/self", async (c) => {
    await detachMachine(deps.db, c.get("principal"), deps.now());
    return c.body(null, 204);
  });
}
