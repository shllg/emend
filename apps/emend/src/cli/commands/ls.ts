import { AgentReviewList, AgentReviewQuery } from "@emend/contract";
import type { Io } from "../../main.ts";
import { listDirect } from "../direct/index.ts";
import { escapeReference } from "../escape.ts";
import { apiRequest, CliError, CliUsageError, printTerminalJson } from "../http.ts";
import { resolveTarget } from "../target.ts";

const USAGE = "Usage: emend ls [--json] [--head <sha>].";

function parse(args: string[]) {
  let json = false;
  let head: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--json" && !json) json = true;
    else if (arg === "--head" && head === undefined) {
      const value = args[++i];
      const parsed = AgentReviewQuery.safeParse({ head: value });
      if (!parsed.success || parsed.data.head === undefined) throw new CliUsageError(USAGE);
      head = parsed.data.head;
    } else throw new CliUsageError(USAGE);
  }
  return { json, query: head === undefined ? {} : { head } };
}

export async function lsCommand(stateDir: string, args: string[], io: Io) {
  const { json, query } = parse(args);
  const target = await resolveTarget(stateDir);
  let list: AgentReviewList;
  if (target.via === "direct") list = await listDirect(stateDir, query);
  else {
    const path = query.head === undefined ? "/agent/reviews" : `/agent/reviews?head=${query.head}`;
    const result = AgentReviewList.safeParse(await apiRequest(stateDir, target, path, { method: "GET" }));
    if (!result.success) throw new CliError("The emend server returned an invalid response.");
    list = result.data;
  }
  if (json) return printTerminalJson(io, list);
  for (const review of list.items)
    io.stdout(
      `${review.id}\t${review.state}\t${review.updatedAt}\t${escapeReference(review.title)}\t${escapeReference(review.url)}\n`,
    );
}
