import { SampleView } from "@recense/contract";
import { buildSampleView } from "@recense/core";
import type { Hono } from "hono";
import type { AppEnv } from "../auth/principal.ts";

let sample: Promise<SampleView> | undefined;
export function sampleRoutes(app: Hono<AppEnv>) {
  app.get("/api/v1/sample", async (c) => {
    sample ??= buildSampleView()
      .then((view) => SampleView.parse(view))
      .catch((error) => {
        sample = undefined;
        throw error;
      });
    return c.json(await sample);
  });
}
