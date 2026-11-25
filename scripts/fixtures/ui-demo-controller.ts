// The demo owns its signal handlers. Run the test round in a child so stop can wait for its exit.
import assert from "node:assert/strict";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  assertSealedPaths, canonicalPath, currentProtectedStateDirs,
} from "../screenshots/safety.ts";
import { startDemo } from "../ui-demo.ts";

const [top, port] = process.argv.slice(2);
// Use the demo's SIGINT cleanup even if the parent disappears during startup.
process.once("disconnect", () => process.kill(process.pid, "SIGINT"));
if (!process.connected) process.exit(0);
const demo = await startDemo(top, async ({ sealed, sealedRoot, env, server }) => {
  const tmpDir = realpathSync(tmpdir());
  assert.equal(dirname(sealedRoot), tmpDir);
  assert.equal(env.RECENSE_HOME, join(sealedRoot, "recense"));
  assertSealedPaths({
    root: sealedRoot, tmpDir, recenseHome: env.RECENSE_HOME,
    realStateDirs: currentProtectedStateDirs(),
  }, canonicalPath);
  const repo = join(sealedRoot, "example");
  mkdirSync(repo);
  sealed.git(repo, env, "init", "-q");
  writeFileSync(join(repo, "plan.md"), "# Example plan\n");
  sealed.git(repo, env, "add", "plan.md");
  sealed.git(repo, env, "commit", "-qm", "add plan");
  const published = await server.cli(["publish", "plan.md", "--json"], repo);
  const { reviewId } = JSON.parse(published);
  assert.equal(typeof reviewId, "string");
  return { reviewId };
}, Number(port));
process.send?.({ root: demo.root, reviewId: demo.reviewId, origin: demo.origin });
