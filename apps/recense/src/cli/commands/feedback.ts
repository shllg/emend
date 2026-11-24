import type { Io } from "../../main.ts";
import { checkSaveFolder } from "../save-feedback.ts";
import { resolveTarget } from "../target.ts";
import { deliverFeedback, parseFeedbackArgs, takeFeedback } from "./wait.ts";

const replyHint =
  "recense: answer each comment with recense reply <comment> --status <outcome> --body <text>, then publish changes with recense publish <path>... --review ";

export async function feedbackCommand(stateDir: string, args: string[], io: Io) {
  const { reviewId, saveFolder } = parseFeedbackArgs("feedback", args);
  const folder = saveFolder ? await checkSaveFolder(saveFolder, stateDir) : undefined;
  try {
    const target = await resolveTarget(stateDir);
    const result = await takeFeedback(stateDir, target, reviewId, 0);
    // The hint follows a confirmed go only: an unconfirmed result is offered again on the next take.
    if ((await deliverFeedback(stateDir, target, result, io, undefined, folder)) && result.kind === "go")
      io.stderr(`${replyHint}${reviewId}\n`);
  } finally {
    await folder?.handle.close().catch(() => {});
  }
}
