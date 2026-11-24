import { ImportBundle, ImportResult } from "@recense/contract";
import type { Hono } from "hono";
import type { AppDeps } from "../app.ts";
import { machineDevice } from "../auth/machines.ts";
import type { AppEnv } from "../auth/principal.ts";
import { parseBody } from "../http/body.ts";
import { importReview } from "../import/ingest.ts";
import { acquireImport, checkImportSignal } from "../import/lifecycle.ts";

export function importRoutes(app: Hono<AppEnv>, deps: AppDeps) {
  app.post("/api/v1/import", async (c) => {
    const principal = c.get("principal");
    await deps.db.read((q) => machineDevice(principal.ownerId, q, principal, deps.now()));
    const release = acquireImport(c.req.raw.signal);
    try {
      const input = parseBody(c, ImportBundle);
      const result = await importReview(principal, input, deps, c.req.raw.signal);
      return c.json(ImportResult.parse(result), result.skipped ? 200 : 201);
    } catch (error) {
      checkImportSignal(c.req.raw.signal);
      throw error;
    } finally {
      release();
    }
  });
}
