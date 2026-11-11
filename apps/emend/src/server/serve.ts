import { randomBytes } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { isIP } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ERROR_STATUS, type ErrorCode } from "@emend/contract";
import { getRequestListener } from "@hono/node-server";
import { writeSecretFile } from "../state/files.ts";
import { type AppDeps, createApp } from "./app.ts";
import { errorBody } from "./http/errors.ts";
import { headersForPath } from "./http/headers.ts";
import { closeCommentRenderer } from "./routes/comment-html.ts";

import { initializeServerState } from "./state.ts";

export { initializeServerState } from "./state.ts";

const urlHost = (host: string) => (host.includes(":") ? `[${host}]` : host);
function localUrl(address: string, port: number) {
  if (!isIP(address)) throw new Error("Invalid bound address.");
  const host = address === "0.0.0.0" ? "127.0.0.1" : address === "::" ? "::1" : address;
  return `http://${urlHost(host)}:${port}`;
}
function publicBaseUrl(publicOrigin?: string) {
  if (!publicOrigin) return undefined;
  const parsed = new URL(publicOrigin);
  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    parsed.pathname !== "/"
  )
    throw new Error("Invalid public origin.");
  return parsed.origin;
}
export function serverConfig(
  address: string,
  port: number,
  webRoot: string,
  publicOrigin?: string,
  serverKey = randomBytes(32).toString("base64url"),
): AppDeps["config"] {
  const url = localUrl(address, port);
  const allowedHosts = ["127.0.0.1", "localhost", "[::1]"].map((name) => `${name}:${port}`);
  allowedHosts.push(new URL(url).host);
  const uniqueHosts = [...new Set(allowedHosts)];
  const publicUrl = publicBaseUrl(publicOrigin);
  const baseUrl = publicUrl ?? url;
  return {
    allowedHosts: [...uniqueHosts, ...(publicUrl ? [new URL(publicUrl).host] : [])],
    appOrigins: [...new Set([...uniqueHosts.map((name) => `http://${name}`), ...(publicUrl ? [publicUrl] : [])])],
    baseUrl,
    secureCookieHost: publicUrl?.startsWith("https:") ? new URL(publicUrl).host : undefined,
    webRoot,
    serverKey,
  };
}
export interface ServerOptions {
  stateDir: string;
  configFile?: string;
  host?: string;
  port?: number;
  publicOrigin?: string;
  webRoot?: string;
  onStopRequest?: () => void;
}
interface DiscoveryIdentity {
  pid: number;
  startedAt: string;
  key: string;
}
export async function startServer(
  opts: ServerOptions,
): Promise<{ url: string; port: number; setPublicOriginReady: (ready: boolean) => void; close: () => Promise<void> }> {
  const host = opts.host ?? "127.0.0.1";
  const port = opts.port ?? 3636;
  const webRoot = opts.webRoot ?? fileURLToPath(new URL("./web/", import.meta.url));
  publicBaseUrl(opts.publicOrigin);
  const state = await initializeServerState(opts.stateDir);
  const key = randomBytes(32).toString("base64url");
  const server = createServer({ requireHostHeader: false });
  try {
    const bound = await new Promise<{ url: string; port: number }>((resolve, reject) => {
      server.once("error", reject);
      server.listen({ host, port }, () => {
        try {
          const address = server.address();
          if (!address || typeof address === "string") throw new Error("Invalid bound address.");
          const config = serverConfig(address.address, address.port, webRoot, opts.publicOrigin, key);
          const app = createApp({
            ...state,
            now: Date.now,
            config,
            configFile: opts.configFile,
            onStopRequest: opts.onStopRequest,
          });
          server.on("request", nodeRequestHandler(app, config));
          resolve({ url: localUrl(address.address, address.port), port: address.port });
        } catch (error) {
          reject(error);
        }
      });
    });
    writeSecretFile(join(opts.stateDir, "server-url.json"), JSON.stringify({ baseUrl: bound.url }), opts.stateDir);
    const discovery = join(opts.stateDir, "server.json");
    const record = { ...bound, pid: process.pid, startedAt: new Date().toISOString(), key };
    writeSecretFile(discovery, JSON.stringify(record), opts.stateDir);
    let closing: Promise<void> | undefined;
    return {
      url: bound.url,
      port: bound.port,
      setPublicOriginReady(ready) {
        if (closing) throw new Error("The emend server is closing.");
        writeSecretFile(
          join(opts.stateDir, "server-url.json"),
          JSON.stringify({ baseUrl: ready ? (publicBaseUrl(opts.publicOrigin) ?? bound.url) : bound.url }),
          opts.stateDir,
        );
      },
      close() {
        closing ??= (async () => {
          try {
            await stopServer(server);
          } finally {
            await closeCommentRenderer();
            await state.db.close();
            await removeDiscovery(discovery, record);
          }
        })();
        return closing;
      },
    };
  } catch (error) {
    await stopServer(server);
    await state.db.close();
    throw error;
  }
}
async function stopServer(server: Server) {
  if (!server.listening) return;
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}
export async function removeDiscovery(path: string, identity: DiscoveryIdentity) {
  try {
    const record: unknown = JSON.parse(await readFile(path, "utf8"));
    if (
      record &&
      typeof record === "object" &&
      "pid" in record &&
      record.pid === identity.pid &&
      "startedAt" in record &&
      record.startedAt === identity.startedAt &&
      "key" in record &&
      record.key === identity.key
    )
      await rm(path, { force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
  }
}
function adapterError(path: string, code: ErrorCode) {
  return new Response(JSON.stringify(errorBody(code)), {
    status: ERROR_STATUS[code],
    headers: {
      ...headersForPath(path),
      "Content-Type": "application/json; charset=UTF-8",
      "Cache-Control": "no-store",
    },
  });
}
export function nodeRequestHandler(
  app: Pick<ReturnType<typeof createApp>, "fetch">,
  config: Pick<AppDeps["config"], "allowedHosts">,
) {
  return async (incoming: IncomingMessage, outgoing: ServerResponse) => {
    const path = incoming.url?.split(/[?#]/, 1)[0] ?? "/";
    const refuse = async (code: ErrorCode) => {
      if (outgoing.headersSent) {
        outgoing.destroy();
        return;
      }
      const response = adapterError(path, code);
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      outgoing.end(incoming.method === "HEAD" ? undefined : await response.text());
    };
    if (!incoming.headers.host || !config.allowedHosts.includes(incoming.headers.host.toLowerCase())) {
      await refuse("bad_host");
      return;
    }
    const adapter = getRequestListener(
      (request) =>
        app.fetch(request, {
          onResponseSent: (callback) => {
            outgoing.once("finish", callback);
          },
        }),
      {
        overrideGlobalObjects: false,
        errorHandler: () => adapterError(path, "invalid_request"),
      },
    );
    try {
      await adapter(incoming, outgoing);
    } catch {
      await refuse("invalid_request");
    }
  };
}
