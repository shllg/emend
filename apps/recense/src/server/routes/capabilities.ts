import {
  AGENT_NOTE_QUOTES_FEATURE,
  AGENT_REVIEW_KEY_FEATURE,
  Capabilities,
  DIFF_IMAGES_FEATURE,
  LEGACY_SERVER_CHALLENGE_HEADER,
  LEGACY_SERVER_PROOF_HEADER,
  REVIEW_BIN_FEATURE,
  REVIEW_GROUPS_FEATURE,
  REVIEW_LIFECYCLE_FEATURE,
  REVIEW_PIN_ORDER_FEATURE,
  REVIEW_PINS_FEATURE,
  SERVER_CHALLENGE_HEADER,
  SERVER_PROOF_HEADER,
  ServerChallenge,
} from "@recense/contract";
import type { Hono } from "hono";
import { VERSION } from "../../version.ts";
import type { AppEnv } from "../auth/principal.ts";
import { serverProof } from "../auth/server-proof.ts";
import { ApiError } from "../http/errors.ts";

export function capabilitiesRoutes(app: Hono<AppEnv>, key: string, canStop = false) {
  app.get("/api/v1/capabilities", (c) => {
    const challenge = c.req.header(SERVER_CHALLENGE_HEADER) ?? c.req.header(LEGACY_SERVER_CHALLENGE_HEADER);
    if (challenge !== undefined) {
      const parsed = ServerChallenge.safeParse(challenge);
      if (!parsed.success) throw new ApiError("invalid_request");
      const proof = serverProof(key, parsed.data);
      c.header(SERVER_PROOF_HEADER, proof);
      c.header(LEGACY_SERVER_PROOF_HEADER, proof);
    }
    return c.json(
      Capabilities.parse({
        api: 1,
        version: VERSION,
        features: [
          "attach",
          "html-docs",
          "mcp",
          REVIEW_LIFECYCLE_FEATURE,
          REVIEW_BIN_FEATURE,
          REVIEW_GROUPS_FEATURE,
          REVIEW_PINS_FEATURE,
          REVIEW_PIN_ORDER_FEATURE,
          AGENT_REVIEW_KEY_FEATURE,
          DIFF_IMAGES_FEATURE,
          AGENT_NOTE_QUOTES_FEATURE,
          ...(canStop ? ["server-stop"] : []),
        ],
      }),
    );
  });
}
