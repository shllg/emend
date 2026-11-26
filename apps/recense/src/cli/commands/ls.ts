import { AgentReviewList, AgentReviewQuery } from "@recense/contract";
import type { Io } from "../../main.ts";
import { listDirect } from "../direct/index.ts";
import { escapeReference } from "../escape.ts";
import { apiRequest, CliError, CliUsageError, printTerminalJson } from "../http.ts";
import { resolveTarget } from "../target.ts";

const USAGE = "Usage: recense ls [--json] [--head <sha>].";

function parse(args: string[]) {
  let json = false;
  const query: AgentReviewQuery = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--json" && !json) json = true;
    else if (arg === "--head" && query.head === undefined) {
      const value = args[++i];
      const parsed = AgentReviewQuery.safeParse({ head: value });
      if (!parsed.success || parsed.data.head === undefined) throw new CliUsageError(USAGE);
      query.head = parsed.data.head;
    } else throw new CliUsageError(USAGE);
  }
  if (!json) query.diff = "0";
  return { json, query };
}

export async function lsCommand(stateDir: string, args: string[], io: Io) {
  const { json, query } = parse(args);
  const target = await resolveTarget(stateDir);
  let list: AgentReviewList;
  if (target.via === "direct") list = await listDirect(stateDir, query);
  else {
    const params = new URLSearchParams(query);
    const path = params.size ? `/agent/reviews?${params}` : "/agent/reviews";
    const result = AgentReviewList.safeParse(await apiRequest(stateDir, target, path, { method: "GET" }));
    if (!result.success) throw new CliError("The recense server returned an invalid response.");
    list = result.data;
  }
  if (json) return printTerminalJson(io, list);
  for (const review of list.items)
    io.stdout(
      `${review.id}\t${review.state}\t${review.updatedAt}\t${escapeReference(review.title)}\t${escapeReference(review.url)}\n`,
    );
}
