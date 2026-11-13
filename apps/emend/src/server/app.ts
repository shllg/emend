import { LIMITS, type Scope } from "@emend/contract";
import { Hono } from "hono";
import type { Db } from "../db/client.ts";
import type { Instance } from "../state/instance.ts";
import type { BlobStore } from "../store/blobs.ts";
import { pairingRedemptions } from "./auth/pairings.ts";
import { type AppEnv, requireScope } from "./auth/principal.ts";
import { secureSessionRequest, sessionCookie, verifySession, writeSessionCookie } from "./auth/sessions.ts";
import { verifyBearer } from "./auth/tokens.ts";
import { contentRoutes } from "./content/route.ts";
import { ReviewEvents } from "./events.ts";
import { checkContentLength, limitJsonBody } from "./http/body.ts";
import { clientVersion } from "./http/client-version.ts";
import { ApiError, errorResponse } from "./http/errors.ts";
import { isApiPath, responseHeaders } from "./http/headers.ts";
import { hostGuard } from "./http/host-guard.ts";
import { originGuard } from "./http/origin-guard.ts";
import { appPage } from "./http/pages.ts";
import type { Executor } from "./publish/work.ts";
import { agentReviewRoutes } from "./routes/agent-reviews.ts";
import { blobRoutes } from "./routes/blobs.ts";
import { capabilitiesRoutes } from "./routes/capabilities.ts";
import { commentRoutes } from "./routes/comments.ts";
import { deliveryRoutes } from "./routes/deliveries.ts";
import { deviceRoutes } from "./routes/devices.ts";
import { downloadRoutes } from "./routes/download.ts";
import { eventRoutes } from "./routes/events.ts";
import { fileRoutes } from "./routes/files.ts";
import { importRoutes } from "./routes/import.ts";
import { lifecycleRoutes } from "./routes/lifecycle.ts";
import { machineRoutes } from "./routes/machines.ts";
import { mediaRoutes } from "./routes/media.ts";
import { pairingRoutes } from "./routes/pairings.ts";
import { publishRoutes } from "./routes/publish.ts";
import { reviewRoutes } from "./routes/reviews.ts";
import { sendRoutes } from "./routes/sends.ts";
import { serverRoutes } from "./routes/server.ts";
import { sessionRoutes } from "./routes/session.ts";
import { settingsRoutes } from "./routes/settings.ts";
import { threadRoutes } from "./routes/threads.ts";
import { viewedRoutes } from "./routes/viewed.ts";

export interface AppDeps {
  db: Db;
  blobs: BlobStore;
  instance: Instance;
  now: () => number;
  configFile?: string;
  publishExecutor?: Executor;
  events?: ReviewEvents;
  onStopRequest?: () => void;
  /** Called with the background blob cleanup of a review delete; tests await it. */
  onBlobCleanup?: (cleanup: Promise<void>) => void;
  config: {
    serverKey: string;
    allowedHosts: string[];
    appOrigins: string[];
    secureCookieHost?: string;
    baseUrl: string;
    webRoot: string;
  };
}
export const ENDPOINTS = [
  { method: "GET", path: "/api/v1/capabilities", scope: "public" },
  { method: "POST", path: "/api/v1/server/stop", scope: "server:stop" },
  { method: "POST", path: "/api/v1/session", scope: "public" },
  { method: "DELETE", path: "/api/v1/session", scope: "read" },
  { method: "POST", path: "/api/v1/pairings", scope: "pairings:create" },
  { method: "GET", path: "/api/v1/devices", scope: "devices:manage" },
  { method: "GET", path: "/api/v1/settings", scope: "read" },
  { method: "PATCH", path: "/api/v1/settings", scope: "settings:manage" },
  { method: "DELETE", path: "/api/v1/devices/:id", scope: "devices:manage" },
  { method: "POST", path: "/api/v1/machines", scope: "public" },
  { method: "DELETE", path: "/api/v1/machines/self", scope: "publish" },
  { method: "HEAD", path: "/api/v1/blobs/:sha256", scope: "publish" },
  { method: "PUT", path: "/api/v1/blobs/:sha256", scope: "publish" },
  { method: "POST", path: "/api/v1/publish", scope: "publish" },
  { method: "POST", path: "/api/v1/import", scope: "publish" },
  { method: "GET", path: "/api/v1/agent/reviews", scope: "publish" },
  { method: "GET", path: "/api/v1/reviews", scope: "read" },
  { method: "GET", path: "/api/v1/reviews/:id", scope: "read" },
  { method: "GET", path: "/api/v1/reviews/:id/revisions/:seq", scope: "read" },
  { method: "GET", path: "/api/v1/reviews/:id/revisions/:seq/download", scope: "read" },
  { method: "PUT", path: "/api/v1/reviews/:id/viewed", scope: "comment" },
  { method: "GET", path: "/api/v1/files/:fileId/old", scope: "read" },
  { method: "GET", path: "/api/v1/files/:fileId/new", scope: "read" },
  { method: "GET", path: "/api/v1/media/:sha256", scope: "read" },
  { method: "GET", path: "/api/v1/events", scope: "read" },
  { method: "GET", path: "/api/v1/reviews/:id/events", scope: "read" },
  { method: "POST", path: "/api/v1/reviews/:id/threads", scope: "comment" },
  { method: "POST", path: "/api/v1/threads/:id/comments", scope: "comment" },
  { method: "PATCH", path: "/api/v1/comments/:id", scope: "comment" },
  { method: "DELETE", path: "/api/v1/comments/:id", scope: "comment" },
  { method: "POST", path: "/api/v1/threads/:id/resolve", scope: "comment" },
  { method: "POST", path: "/api/v1/threads/:id/reopen", scope: "comment" },
  { method: "POST", path: "/api/v1/reviews/:id/sends", scope: "send" },
  { method: "POST", path: "/api/v1/reviews/:id/snooze", scope: "send" },
  { method: "POST", path: "/api/v1/reviews/:id/unsnooze", scope: "send" },
  { method: "POST", path: "/api/v1/reviews/:id/retire", scope: "send" },
  { method: "POST", path: "/api/v1/reviews/:id/reopen", scope: "send" },
  { method: "DELETE", path: "/api/v1/reviews/:id", scope: "send" },
  { method: "POST", path: "/api/v1/reviews/:id/bin", scope: "send" },
  { method: "POST", path: "/api/v1/reviews/:id/restore", scope: "send" },
  { method: "GET", path: "/api/v1/bin", scope: "send" },
  { method: "DELETE", path: "/api/v1/bin", scope: "send" },
  { method: "DELETE", path: "/api/v1/bin/:id", scope: "send" },
  { method: "POST", path: "/api/v1/reviews/:id/take", scope: "take" },
  { method: "POST", path: "/api/v1/deliveries/:id/confirm", scope: "take" },
  { method: "POST", path: "/api/v1/comments/:id/reply", scope: "reply" },
  { method: "GET", path: "/content/:contentKey/*", scope: "public" },
] as const satisfies readonly { method: string; path: string; scope: Scope | "public" }[];
const endpointMatchers = ENDPOINTS.map((entry) => ({
  ...entry,
  match: new RegExp(`^${entry.path.replace(/:[^/]+/g, "[^/]+").replace(/\*/g, ".*")}$`),
}));

export function createApp(deps: AppDeps) {
  deps.events ??= new ReviewEvents(deps.now);
  const app = new Hono<AppEnv>({ strict: true });
  app.onError((error, c) => {
    responseHeaders(c);
    if (error instanceof ApiError) return errorResponse(c, error.code, error.detail);
    console.error("emend: internal server error");
    return errorResponse(c, "internal");
  });
  app.notFound((c) => errorResponse(c, "not_found"));
  app.use("*", async (c, next) => {
    // Response decoration also covers guard refusals through onError.
    hostGuard(c, deps.config.allowedHosts);
    responseHeaders(c);
    clientVersion(c);
    originGuard(c, deps.config.appOrigins);
    if (!isApiPath(c.req.path)) return next();
    const endpoint =
      endpointMatchers.find((entry) => entry.method === c.req.method && entry.match.test(c.req.path)) ??
      (c.req.method === "HEAD"
        ? endpointMatchers.find((entry) => entry.method === "GET" && entry.match.test(c.req.path))
        : undefined);
    const blobUpload = c.req.method === "PUT" && c.req.path.startsWith("/api/v1/blobs/");
    const json =
      endpoint &&
      !blobUpload &&
      (["POST", "PATCH", "PUT"].includes(c.req.method) || (c.req.method === "DELETE" && c.req.path === "/api/v1/bin"));
    const limit = ["/api/v1/publish", "/api/v1/import"].includes(c.req.path)
      ? LIMITS.publishJsonBytes
      : ["/api/v1/session", "/api/v1/machines"].includes(c.req.path)
        ? LIMITS.publicJsonBytes
        : LIMITS.requestJsonBytes;
    if (json) checkContentLength(c, limit);
    if (blobUpload) checkContentLength(c, LIMITS.assetBytes);
    if (endpoint?.scope !== "public") {
      const authorization = c.req.header("Authorization");
      let principal = authorization !== undefined ? await verifyBearer(deps.db, authorization, deps.now()) : null;
      if (authorization === undefined) {
        const secret = sessionCookie(c);
        const session = await verifySession(deps.db, secret, deps.now());
        if (session) {
          principal = session.principal;
          if (session.renew && secret) {
            const secure = secureSessionRequest(c, deps.config.secureCookieHost);
            const readOnly = c.req.method === "GET" || c.req.method === "HEAD";
            // Reads skip Origin checks, so a rewritten Host must not downgrade the cookie.
            if (deps.config.secureCookieHost === undefined || secure || !readOnly)
              writeSessionCookie(c, secret, secure);
          }
        }
      }
      if (!principal) throw new ApiError("unauthorized");
      c.set("principal", principal);
      if (endpoint) requireScope(c, endpoint.scope);
    }
    if (!endpoint) throw new ApiError("not_found");
    if (json) await limitJsonBody(c, limit);
    await next();
  });
  capabilitiesRoutes(app, deps.config.serverKey, deps.onStopRequest !== undefined);
  serverRoutes(app, deps);
  pairingRoutes(app, deps);
  deviceRoutes(app, deps);
  settingsRoutes(app, deps);
  const redemptions = pairingRedemptions(deps.now);
  sessionRoutes(app, deps, redemptions);
  machineRoutes(app, deps, redemptions);
  importRoutes(app, deps);
  blobRoutes(app, deps);
  publishRoutes(app, deps);
  agentReviewRoutes(app, deps);
  reviewRoutes(app, deps);
  downloadRoutes(app, deps);
  lifecycleRoutes(app, deps);
  viewedRoutes(app, deps);
  fileRoutes(app, deps);
  mediaRoutes(app, deps);
  threadRoutes(app, deps);
  commentRoutes(app, deps);
  sendRoutes(app, deps);
  deliveryRoutes(app, deps);
  eventRoutes(app, deps);
  contentRoutes(app, deps);
  app.get("*", (c) => {
    if (isApiPath(c.req.path) || c.req.path.startsWith("/content/")) throw new ApiError("not_found");
    return appPage(c, deps.config.webRoot);
  });
  return app;
}
