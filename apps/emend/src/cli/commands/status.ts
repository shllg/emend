import { stat } from "node:fs/promises";
import { join } from "node:path";
import { type AgentReviewItem, AgentReviewList, LIMITS } from "@emend/contract";
import type { Io } from "../../main.ts";
import { VERSION } from "../../version.ts";
import { escapeReference } from "../escape.ts";
import { createGitSession } from "../git.ts";
import { apiRequest, CliUsageError, printTerminalJson, sandboxHint } from "../http.ts";
import { codeRoot } from "../publish/context.ts";
import { reviewKey } from "../publish/key.ts";
import { readRegular } from "../publish/read.ts";
import { discover } from "../server-client.ts";
import {
  attachedTarget,
  type HttpTarget,
  hubCapabilities,
  localTarget,
  readAttachment,
  readAttachmentPair,
} from "../target.ts";

/** Read this machine's instance name. It creates nothing; a missing or unreadable file reads as none. */
async function instanceName(stateDir: string): Promise<string | null> {
  try {
    const bytes = await readRegular(join(stateDir, "instance.json"), LIMITS.publicJsonBytes);
    const value: unknown = JSON.parse(bytes.toString());
    return value && typeof value === "object" && "name" in value && typeof value.name === "string" ? value.name : null;
  } catch {
    return null;
  }
}

/** A fixed status line containing only revision numbers from the server. */
export function statusLineText(item: AgentReviewItem): string | null {
  if (item.newest === null) return null;
  if (item.state === "approved") return `emend r${item.approved?.revision ?? item.newest.revision} · approved`;
  const revision = `emend r${item.newest.revision}`;
  if (item.state === "settled") return `${revision} · retired`;
  if (item.turn === "reviewer") return `${revision} · your turn`;
  if (item.turn === "agent") return `${revision} · agent's turn`;
  return revision;
}

async function statusLine(stateDir: string, io: Io): Promise<void> {
  try {
    const signal = AbortSignal.timeout(2000);
    const git = createGitSession();
    const { worktree, root } = await codeRoot(process.cwd(), stateDir, git);
    if (!worktree) return;
    const branch = (await git(root, ["rev-parse", "--abbrev-ref", "HEAD"])).toString().trim();
    if (!branch || branch === "HEAD") return;
    const instance = JSON.parse(
      (await readRegular(join(stateDir, "instance.json"), LIMITS.publicJsonBytes)).toString(),
    );
    if (typeof instance.id !== "string" || !/^[a-f0-9-]{36}$/i.test(instance.id)) return;
    const key = reviewKey(instance.id, root, branch);
    signal.throwIfAborted();
    const pair = await readAttachmentPair(stateDir);
    let target: HttpTarget;
    if (pair) {
      target = attachedTarget(pair);
      await hubCapabilities(target.url, signal, stateDir);
    } else {
      const server = await discover(stateDir, 1000);
      if (!server) return;
      target = await localTarget(stateDir, server.url);
    }
    const result = AgentReviewList.safeParse(
      await apiRequest(stateDir, target, `/agent/reviews?key=${key}`, {
        method: "GET",
        signal,
        timeoutMs: 1500,
        ...(target.via === "local"
          ? { verifyLocal: async () => (await discover(stateDir, 1000, target.url)) !== null }
          : {}),
      }),
    );
    if (!result.success) return;
    const item = result.data.items.find((item) => item.branch === branch);
    if (!item) return;
    const line = statusLineText(item);
    signal.throwIfAborted();
    if (line !== null) io.stdout(`${line}\n`);
  } catch {
    // A status line stays silent on every error, including a failed stdout write.
  }
}

/** Where this machine's agent commands go, or the branch's review. It creates no file or folder. */
export async function statusCommand(stateDir: string, args: string[], io: Io) {
  if (args.length > 1 || (args.length === 1 && args[0] !== "--json" && args[0] !== "--line"))
    throw new CliUsageError("Usage: emend status [--json | --line].");
  if (args[0] === "--line") return statusLine(stateDir, io);
  // A missing state folder is reported, never created: a sandbox may hide the real one.
  const missing = await stat(stateDir).then(
    () => false,
    (error: NodeJS.ErrnoException) => error.code === "ENOENT",
  );
  if (missing)
    io.stderr(
      `emend: state folder ${escapeReference(stateDir)} not found: emend has not run on this machine yet, or an agent sandbox hides it. ${sandboxHint}\n`,
    );
  const attachment = await readAttachment(stateDir);
  const instance = await instanceName(stateDir);
  let address: string | null;
  let answering: boolean;
  if (attachment) {
    address = attachment.hubUrl;
    answering = await hubCapabilities(address, undefined, stateDir).then(
      () => true,
      () => false,
    );
  } else {
    const server = await discover(stateDir, 5000);
    address = server?.url ?? null;
    answering = server !== null;
  }
  const status = {
    mode: attachment ? "attached" : "local",
    address,
    hub: attachment?.hubName ?? null,
    instance,
    answering,
    version: VERSION,
  };
  if (args.length) return printTerminalJson(io, status);
  const lines = [
    `mode: ${status.mode}`,
    `address: ${address === null ? "none" : escapeReference(address)}`,
    ...(status.hub === null ? [] : [`hub: ${escapeReference(status.hub)}`]),
    `instance: ${instance === null ? "none" : escapeReference(instance)}`,
    `server: ${answering ? "answering" : "not answering"}`,
    `version: ${VERSION}`,
  ];
  io.stdout(`${lines.join("\n")}\n`);
}
