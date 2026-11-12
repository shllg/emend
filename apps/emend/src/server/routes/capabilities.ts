import {
  Capabilities,
  REVIEW_BIN_FEATURE,
  REVIEW_LIFECYCLE_FEATURE,
  SERVER_CHALLENGE_HEADER,
  SERVER_PROOF_HEADER,
  ServerChallenge,
} from "@emend/contract";
import type { Hono } from "hono";
import { VERSION } from "../../version.ts";
import type { AppEnv } from "../auth/principal.ts";
import { serverProof } from "../auth/server-proof.ts";
import { ApiError } from "../http/errors.ts";

export function capabilitiesRoutes(app: Hono<AppEnv>, key: string, canStop = false) {
  app.get("/api/v1/capabilities", (c) => {
    const challenge = c.req.header(SERVER_CHALLENGE_HEADER);
    if (challenge !== undefined) {
      const parsed = ServerChallenge.safeParse(challenge);
      if (!parsed.success) throw new ApiError("invalid_request");
      c.header(SERVER_PROOF_HEADER, serverProof(key, parsed.data));
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
          ...(canStop ? ["server-stop"] : []),
        ],
      }),
    );
  });
}
