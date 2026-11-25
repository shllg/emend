import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { assertSealedPaths, canonicalPath, currentProtectedStateDirs } from "./screenshots/safety.ts";
import { rebuild, startDemo } from "./ui-demo.ts";

const recense = join(import.meta.dirname, "..", "apps", "recense");
const { build } = createRequire(join(recense, "package.json"))("esbuild");

function writeWeb(dist: string, version: string) {
  mkdirSync(join(dist, "assets"), { recursive: true });
  writeFileSync(join(dist, "index.html"), `<!doctype html><title>${version}</title>`);
  writeFileSync(join(dist, "assets", "app.js"), `document.title = '${version}'`);
  writeFileSync(join(dist, "pub-frame.css"), `/* ${version} */`);
}

async function listenOnWorktreePort() {
  for (let port = 3637; port <= 3656; port++) {
    const listener = createServer((socket) => socket.end());
    try {
      await new Promise<void>((done, reject) => {
        listener.once("error", reject);
        listener.listen(port, "127.0.0.1", done);
      });
      return {
        port,
        close: () => new Promise<void>((done, reject) => listener.close((error) => error ? reject(error) : done())),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
    }
  }
  throw new Error("No free worktree port for the demo test");
}

test("a worktree demo refuses unsafe ports and rebuilds a private app copy with the round intact", { timeout: 120_000 }, async (t) => {
  const tmpDir = realpathSync(tmpdir());
  const top = mkdtempSync(join(tmpDir, "recense-demo-test-"));
  let lastPhase = "setup";
  function phase(name: string) {
    lastPhase = name;
    t.diagnostic(name);
  }
  // The runner can time out while the test body is still waiting on a live resource.
  const watchdog = setTimeout(() => {
    writeSync(2, `UI demo stalled after ${lastPhase}. Active resources: ${JSON.stringify(process.getActiveResourcesInfo())}\n`);
    process.exit(1);
  }, 150_000).unref();
  try {
    const wt = join(top, ".wt");
    const cliDist = join(top, "apps", "recense", "dist");
    const web = join(top, "apps", "web", "dist");
    mkdirSync(wt);
    writeFileSync(join(top, ".git"), "gitdir: synthetic");
    const portFile = join(wt, "worktree.json");
    const stateFile = join(wt, "ui-demo.json");
    const state = () => JSON.parse(readFileSync(stateFile, "utf8"));
    writeFileSync(portFile, JSON.stringify({ port: 3636 }));
    await assert.rejects(startDemo(top), /worktree port/);

    const listener = await listenOnWorktreePort();
    try {
      writeFileSync(portFile, JSON.stringify({ port: listener.port }));
      await assert.rejects(startDemo(top), /Run pnpm build first/);
      phase("refusals done");
      // CI's harness job has no checkout build. Use the CLI and worker entries of apps/recense/build.ts.
      await build({
        entryPoints: {
          recense: join(recense, "src", "cli.ts"),
          "publish-worker": join(recense, "src", "server", "publish", "worker.ts"),
        },
        outdir: cliDist,
        outExtension: { ".js": ".mjs" },
        bundle: true,
        platform: "node",
        target: "node24",
        format: "esm",
        external: ["node:*"],
      });
      phase("CLI bundled");
      writeWeb(web, "first");
      mkdirSync(join(web, ".vite"));
      writeFileSync(join(web, ".vite", "manifest.json"), "{}");
      mkdirSync(join(cliDist, "web"));
      writeFileSync(join(cliDist, "web", "stale.txt"), "stale");
      await assert.rejects(startDemo(top), /already accepts connections/);
      phase("port-in-use refused");
    } finally {
      await listener.close();
    }

    let publishedId: string | undefined;
    const demo = await startDemo(top, async ({ sealed, sealedRoot, env, server }) => {
      phase("demo started");
      assert.equal(dirname(sealedRoot), tmpDir);
      assert.equal(env.RECENSE_HOME, join(sealedRoot, "recense"));
      assertSealedPaths({ root: sealedRoot, tmpDir, recenseHome: env.RECENSE_HOME, realStateDirs: currentProtectedStateDirs() }, canonicalPath);
      const repo = join(sealedRoot, "example");
      mkdirSync(repo);
      sealed.git(repo, env, "init", "-q");
      writeFileSync(join(repo, "plan.md"), "# Example plan\n");
      sealed.git(repo, env, "add", "plan.md");
      sealed.git(repo, env, "commit", "-qm", "add plan");
      const published = await server.cli(["publish", "plan.md", "--json"], repo);
      const { reviewId } = JSON.parse(published);
      assert.equal(typeof reviewId, "string");
      publishedId = reviewId;
      phase("round published");
      return { reviewId };
    });
    try {
      const indexHash = async () => {
        const response = await fetch(demo.origin, { redirect: "error", signal: AbortSignal.timeout(3000) });
        assert.equal(response.status, 200);
        return createHash("sha256").update(Buffer.from(await response.arrayBuffer())).digest("hex");
      };
      const sourceHash = () => createHash("sha256").update(readFileSync(join(web, "index.html"))).digest("hex");
      assert.equal(statSync(stateFile).mode & 0o777, 0o600);
      assert.equal(state().reviewId, publishedId);
      assert(!existsSync(join(demo.root, "app", "web", ".vite")));
      assert(!existsSync(join(demo.root, "app", "web", "stale.txt")));
      await assert.rejects(startDemo(top), /already has a live UI demo/);
      const oldHash = await indexHash();
      assert.equal(oldHash, sourceHash());
      const oldBuild = state().build;
      const origin = await rebuild(top, async () => {
        writeWeb(web, "second");
        assert.equal(await indexHash(), oldHash, "checkout builds cannot change the served copy");
      });
      assert.equal(origin, demo.origin);
      assert.equal(await indexHash(), sourceHash());
      assert.notEqual(sourceHash(), oldHash);
      assert.equal(state().build, oldBuild + 1);
      assert.equal(state().reviewId, publishedId);
      assert(!existsSync(join(demo.root, "app", "web", ".vite")));
      phase("rebuilt");
    } finally {
      await demo.stop();
    }
    assert(!existsSync(demo.root));
    assert(!existsSync(stateFile));
    phase("stopped");
  } finally {
    clearTimeout(watchdog);
    rmSync(top, { recursive: true, force: true });
  }
});
