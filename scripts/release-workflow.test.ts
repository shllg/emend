import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const workflow = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
const jobs = new Map(
  [...workflow.split("\njobs:\n")[1].matchAll(/^  ([\w-]+):\n([\s\S]*?)(?=^  [\w-]+:\n|(?![\s\S]))/gm)].map((match) => [
    match[1],
    match[2],
  ]),
);

function needs(body: string): string[] {
  const value = /^    needs: (.+)$/m.exec(body)?.[1];
  return value
    ? value
        .replace(/[\[\]\s]/g, "")
        .split(",")
        .sort()
    : [];
}

function steps(body: string): string[] {
  return body.split(/^      - /m).slice(1);
}

test("release jobs keep the verification, publishing and marking dependency graph", () => {
  const graph = {
    plan: [],
    verify: ["plan"],
    build: ["plan", "verify"],
    tag: ["plan", "build"],
    publish: ["plan", "build", "tag"],
    mark: ["plan", "publish"],
  };
  assert.deepEqual([...jobs.keys()].sort(), Object.keys(graph).sort());
  for (const [job, dependencies] of Object.entries(graph)) {
    assert.deepEqual(needs(jobs.get(job) ?? ""), dependencies.sort(), job);
  }
});

test("build requires successful verification without a job condition override", () => {
  const build = jobs.get("build");
  assert(build, "missing build job");
  const keys = [...build.matchAll(/^    (?:"([^"]+)"|'([^']+)'|([\w-]+))[ \t]*:/gm)]
    .map((match) => match[1] ?? match[2] ?? match[3]);
  assert(!keys.includes("if"), "build must use the default success condition for its plan and verify dependencies");
});

test("every needs output reference names a declared output of a direct dependency", () => {
  const outputs = new Map(
    [...jobs].map(([job, body]) => {
      const block = /^    outputs:\n((?:      [^\n]+\n)+)/m.exec(body)?.[1] ?? "";
      return [job, new Set([...block.matchAll(/^      ([\w-]+):/gm)].map((match) => match[1]))];
    }),
  );
  let references = 0;
  for (const [consumer, body] of jobs) {
    for (const [reference, job, output] of body.matchAll(/needs\.([\w-]+)\.outputs\.([\w-]+)/g)) {
      references++;
      assert(outputs.get(job)?.has(output), `${consumer}: undeclared ${reference}`);
      assert(needs(body).includes(job), `${consumer}: ${job} is not a direct dependency`);
    }
  }
  assert(references > 0);
});

test("tarball, notes and manifests artifacts keep matching upload and download names", () => {
  const uploads: [string, string][] = [];
  const downloads: [string, string][] = [];
  for (const [job, body] of jobs) {
    for (const step of steps(body)) {
      const action = /^uses: actions\/(upload|download)-artifact@/.exec(step)?.[1];
      if (!action) continue;
      const name = /^          name: (.+)$/m.exec(step)?.[1];
      assert(name, `${job}: artifact name is missing`);
      (action === "upload" ? uploads : downloads).push([job, name]);
    }
  }
  assert.deepEqual(uploads.sort(), [
    ["build", "release-manifests"],
    ["build", "release-tarball"],
    ["plan", "release-notes"],
  ]);
  assert.deepEqual(downloads.sort(), [
    ["mark", "release-manifests"],
    ["mark", "release-notes"],
    ["publish", "release-tarball"],
  ]);
  assert.deepEqual(uploads.map(([, name]) => name).sort(), downloads.map(([, name]) => name).sort());
});

test("release actions are pinned to full commit SHAs", () => {
  const uses = [...workflow.matchAll(/^\s*- uses: (.+)$/gm)];
  assert(uses.length > 0);
  for (const [, action] of uses) assert.match(action, /^[\w/-]+@[0-9a-f]{40} # v[\d.]+$/);
  assert(workflow.includes("actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9 # v7.0.2"));
  assert(workflow.includes("actions/download-artifact@9000827ccba6bdab643e8b6fd33ac0654aef8333 # v8.0.2"));
});

test("each job has minimal explicit permissions; only publish can mint an OIDC token", () => {
  assert.match(workflow, /^permissions: \{\}$/m);
  for (const [name, permission] of Object.entries({
    plan: "contents: read",
    verify: "contents: read",
    build: "contents: read",
    tag: "contents: write",
    publish: "id-token: write",
    mark: "contents: write",
  })) {
    const body = jobs.get(name);
    assert(body, `missing ${name} job`);
    const permissions = /^    permissions:\n((?:      [^\n]+\n)+)/m.exec(body)?.[1];
    assert.equal(permissions, `      ${permission}\n`, name);
    if (name !== "publish") assert(!body.includes("id-token:"));
  }
  assert.equal([...workflow.matchAll(/id-token:/g)].length, 1);
});

test("publish uses the npm environment on a hosted runner without checking out code or running pnpm", () => {
  const publish = jobs.get("publish");
  assert(publish);
  assert.match(publish, /^    environment: npm$/m);
  assert.match(publish, /^    runs-on: ubuntu-latest$/m);
  assert(!publish.includes("actions/checkout"));
  assert(!publish.includes("pnpm"));
  assert.match(publish, /npm publish --ignore-scripts --access public "\$tarball"/);
  const setupNode = steps(publish).filter((step) => step.startsWith("uses: actions/setup-node@"));
  assert.equal(setupNode.length, 1);
  assert(!setupNode[0].includes("registry-url:"), "npm OIDC must not get a placeholder registry token");
  assert(!/NODE_AUTH_TOKEN|NPM_TOKEN|secrets\./.test(workflow));
});

test("run scripts receive expressions only through env", () => {
  const lines = workflow.split("\n");
  let scripts = 0;
  for (let i = 0; i < lines.length; i++) {
    const match = /^(\s*)(?:- )?run:\s*(.*)$/.exec(lines[i]);
    if (!match) continue;
    scripts++;
    assert(!match[2].includes("${{"), lines[i]);
    const indent = match[1].length + (lines[i].trimStart().startsWith("- ") ? 2 : 0);
    for (let j = i + 1; j < lines.length; j++) {
      if (!lines[j].trim()) continue;
      const nested = /^\s*/.exec(lines[j])?.[0].length ?? 0;
      if (nested <= indent) break;
      assert(!lines[j].includes("${{"), lines[j]);
    }
  }
  assert(scripts > 0);
});

test("the workflow gates the selected SHA and keeps dry runs free of remote mutations", () => {
  assert.match(jobs.get("plan") ?? "", /if: github.ref == 'refs\/heads\/main' && github.repository == 'shllg\/emend'/);
  assert.match(jobs.get("plan") ?? "", /^    if: .*&& vars\.RELEASE_ENABLED == 'true'$/m);
  assert.match(jobs.get("verify") ?? "", /^    uses: \.\/\.github\/workflows\/verify\.yml$/m);
  assert.match(jobs.get("verify") ?? "", /^      ref: \$\{\{ needs.plan.outputs.sha \}\}$/m);
  assert.match(jobs.get("verify") ?? "", /^      sync-base: \$\{\{ needs.plan.outputs.previous \}\}$/m);
  for (const name of ["tag", "publish", "mark"]) {
    assert.match(jobs.get(name) ?? "", /^    if: \$\{\{ !inputs.dry_run && vars\.RELEASE_ENABLED == 'true' \}\}$/m);
    assert(!(jobs.get(name) ?? "").includes("actions/checkout"));
  }
  for (const match of workflow.matchAll(/uses: actions\/checkout@[^\n]+\n((?:        .*\n)+)/g)) {
    assert.match(match[1], /persist-credentials: false/);
    assert.match(match[1], /fetch-depth: 0/);
  }
});

test("plan fetches all branches and tags so origin/release can be checked", () => {
  const checkouts = steps(jobs.get("plan") ?? "").filter((step) => step.startsWith("uses: actions/checkout@"));
  assert.equal(checkouts.length, 1);
  assert.match(checkouts[0], /^          fetch-depth: 0$/m);
  assert.match(checkouts[0], /^          fetch-tags: true$/m);
});

test("publish accepts an earlier build only when resuming and verifies artifact integrity", () => {
  const publish = jobs.get("publish") ?? "";
  assert.match(publish, /\[ "\$actual" = "\$INTEGRITY" \] \|\| \{ echo "Tarball integrity mismatch" >&2; exit 1; \}/);
  assert.match(
    publish,
    /\[ -n "\$existing" \] \|\| \{ echo "npm returned empty integrity for \$VERSION" >&2; exit 1; \}/,
  );
  assert.match(
    publish,
    /if \[ "\$existing" = "\$INTEGRITY" \]; then\s+echo "Matching package is already published\."\s+elif \[ "\$RESUME" = true \]; then\s+echo "Version already published from an earlier build; skipping\."\s+else\s+echo "npm has \$VERSION from a build this run did not make" >&2\s+exit 1/,
  );
  assert.match(
    publish,
    /elif grep -q 'E404' "\$RUNNER_TEMP\/npm-error"; then\s+\[ "\$GITHUB_SHA" = "\$SHA" \] \|\| \{ echo "[^"\n]*provenance[^"\n]*" >&2; exit 1; \}\s+npm publish --ignore-scripts --access public "\$tarball"\s+else\s+cat "\$RUNNER_TEMP\/npm-error" >&2\s+exit 1/,
  );
});

test("plan exposes resume and publish receives it and the planned SHA through env", () => {
  const outputBlock = /^    outputs:\n((?:      [^\n]+\n)+)/m.exec(jobs.get("plan") ?? "")?.[1] ?? "";
  assert.match(outputBlock, /^      resume: \$\{\{ steps.plan.outputs.resume \}\}$/m);
  const publishStep = steps(jobs.get("publish") ?? "").find((step) =>
    step.startsWith("name: Publish the verified tarball"),
  );
  assert(publishStep);
  const env = /^        env:\n((?:          [^\n]+\n)+)/m.exec(publishStep)?.[1] ?? "";
  assert.match(env, /^          RESUME: \$\{\{ needs.plan.outputs.resume \}\}$/m);
  assert.match(env, /^          SHA: \$\{\{ needs.plan.outputs.sha \}\}$/m);
});

test("all artifact uploads overwrite previous attempts in the same run", () => {
  const uploads = [...jobs.values()].flatMap(steps).filter((step) => step.startsWith("uses: actions/upload-artifact@"));
  assert.equal(uploads.length, 3);
  for (const step of uploads) {
    assert.match(step, /^          overwrite: true$/m);
    assert.match(step, /^          if-no-files-found: error$/m);
  }
});

test("build writes the manifests with the package version immediately after stamping the build", () => {
  const build = steps(jobs.get("build") ?? "");
  const stamp = build.findIndex((step) => step.startsWith('run: node scripts/release.ts stamp "$VERSION"'));
  assert(stamp >= 0);
  assert.match(build[stamp + 1], /^run: node scripts\/release.ts manifests "\$VERSION" "\$RUNNER_TEMP\/manifests"\n/);
  for (const step of [build[stamp], build[stamp + 1]]) {
    assert.match(step, /^          VERSION: \$\{\{ needs.plan.outputs.version \}\}$/m);
  }
  for (const job of ["build", "mark"]) {
    const artifact = steps(jobs.get(job) ?? "").find((step) => step.includes("name: release-manifests"));
    assert(artifact);
    assert.match(artifact, /^          path: \$\{\{ runner.temp \}\}\/manifests$/m);
  }
});

test("tag compares the live release source before accepting or creating a tag and peels annotated tags", () => {
  const tag = jobs.get("tag") ?? "";
  const resolution = tag.indexOf('gh api "repos/$GH_REPO/git/ref/heads/release" --jq .object.sha');
  const manifest = tag.indexOf('"repos/$GH_REPO/contents/plugin/.claude-plugin/plugin.json?ref=$release_sha"');
  const source = tag.indexOf('gh api "repos/$GH_REPO/git/commits/$release_sha" --jq \'.parents[0].sha\'');
  const comparison = tag.indexOf('gh api "repos/$GH_REPO/compare/$source_sha...$SHA" --jq .status');
  const lookup = tag.indexOf('gh api "repos/$GH_REPO/git/ref/tags/v$VERSION"');
  assert(
    resolution >= 0 && manifest > resolution && source > manifest && comparison > source && lookup > comparison,
  );
  assert(!tag.includes("/compare/release..."), "a tag named release must not shadow the branch");
  assert(!tag.includes("/compare/$release_sha..."), "the stamp commit itself is never main's ancestor");
  assert.match(
    tag,
    /if ! release_sha=\$\(gh api "repos\/\$GH_REPO\/git\/ref\/heads\/release" --jq \.object.sha\); then\s+echo "could not resolve the release branch" >&2\s+exit 1\s+fi/,
  );
  assert.match(
    tag,
    /if ! comparison=\$\(gh api "repos\/\$GH_REPO\/compare\/\$source_sha\.\.\.\$SHA" --jq \.status\); then\s+echo "could not compare release with \$SHA" >&2\s+exit 1\s+fi/,
  );
  assert.match(
    tag,
    /if \[ "\$comparison" != ahead \] && \[ "\$comparison" != identical \]; then\s+echo "release is ahead of or diverged from \$SHA; refusing a stale run" >&2\s+exit 1/,
  );
  assert.match(
    tag,
    /while \[ "\$type" = tag \]; do\s+object=\$\(gh api "repos\/\$GH_REPO\/git\/tags\/\$current" --jq '\.object \| \[\.type, \.sha\] \| @tsv'\)\s+read -r type current <<< "\$object"\s+done/,
  );
  assert.match(
    tag,
    /\[ "\$type" = commit \] && \[ "\$current" = "\$SHA" \] \|\| \{ echo "Tag v\$VERSION points at another commit" >&2; exit 1; \}/,
  );
});

test("tag and mark resolve a stamp's first parent and refuse manifest or source lookup failures", () => {
  for (const job of ["tag", "mark"]) {
    const body = jobs.get(job) ?? "";
    assert.match(
      body,
      /if ! plugin=\$\(gh api -H "Accept: application\/vnd.github.raw\+json" "repos\/\$GH_REPO\/contents\/plugin\/\.claude-plugin\/plugin.json\?ref=\$release_sha"\); then\s+echo "could not read plugin\/\.claude-plugin\/plugin.json at \$release_sha" >&2\s+exit 1/,
    );
    assert.match(body, /release_version=\$\(jq -r '\.version \/\/ empty' <<< "\$plugin"\)/);
    assert.match(body, /source_sha="\$release_sha"\s+if \[ -n "\$release_version" \]; then/);
    assert.match(
      body,
      /if ! source_sha=\$\(gh api "repos\/\$GH_REPO\/git\/commits\/\$release_sha" --jq '\.parents\[0\].sha'\); then\s+echo "could not resolve the release source at \$release_sha" >&2\s+exit 1/,
    );
    assert(body.includes('echo "release stamp has no first parent" >&2; exit 1;'));
  }
});

test("mark verifies manifests after creating release notes and before creating the stamp commit", () => {
  const mark = jobs.get("mark") ?? "";
  const create = mark.indexOf("gh release create");
  const validation = mark.indexOf("jq -e --arg version");
  const tree = mark.indexOf('gh api --method POST "repos/$GH_REPO/git/trees"');
  const commit = mark.indexOf('gh api --method POST "repos/$GH_REPO/git/commits"');
  const move = mark.indexOf('gh api --method PATCH "repos/$GH_REPO/git/refs/heads/release"');
  assert(create >= 0 && validation > create && tree > validation && commit > tree && move > commit);
  assert(mark.indexOf("name: release-notes") < create);
  assert(mark.indexOf("name: release-manifests") < validation);
  const stamp = steps(mark).find((step) => step.startsWith("name: Stamp and move"));
  assert(stamp);
  assert.match(stamp, /^        shell: bash$/m);
  assert.match(stamp, /^          VERSION: \$\{\{ needs.plan.outputs.version \}\}$/m);
  assert.match(stamp, /for path in plugin\/\.claude-plugin\/plugin.json \.claude-plugin\/marketplace.json; do/);
  assert(
    stamp.includes('gh api -H "Accept: application/vnd.github.raw+json" "repos/$GH_REPO/contents/$path?ref=$SHA"'),
  );
  assert(
    stamp.includes(
      'if ! jq -e --arg version "$VERSION" --argjson original "$original" \'. == ($original + {version: $version})\' "$RUNNER_TEMP/manifests/${path##*/}"; then',
    ),
  );
  assert.match(stamp, /echo "stamped manifest does not match \$path at \$SHA with version \$VERSION" >&2\s+exit 1/);
});

test("mark uses the tagged tree and only the two stamped blobs without custom commit identity or signature", () => {
  const mark = jobs.get("mark") ?? "";
  assert(mark.includes('base_tree=$(gh api "repos/$GH_REPO/git/commits/$SHA" --jq .tree.sha)'));
  assert(mark.includes('tree=$(jq -n --arg base_tree "$base_tree"'));
  for (const name of ["plugin", "marketplace"]) {
    assert(mark.includes(`--rawfile ${name} "$RUNNER_TEMP/manifests/${name}.json"`));
  }
  assert.match(
    mark,
    /'\{base_tree: \$base_tree, tree: \[\s+\{path: "plugin\/\.claude-plugin\/plugin.json", mode: "100644", type: "blob", content: \$plugin\},\s+\{path: "\.claude-plugin\/marketplace.json", mode: "100644", type: "blob", content: \$marketplace\}\s+\]\}'/,
  );
  assert(mark.includes('gh api --method POST "repos/$GH_REPO/git/trees" --input - --jq .sha'));
  assert(mark.includes('--arg message "chore: stamp emend $VERSION into the plugin manifests"'));
  assert(mark.includes('--arg tree "$tree" --argjson parents "$parents"'));
  assert(mark.includes("'{message: $message, tree: $tree, parents: $parents}'"));
  assert(mark.includes('gh api --method POST "repos/$GH_REPO/git/commits" --input - --jq .sha'));
  assert(!/\b(author|committer|signature)\b/i.test(mark));
});

test("mark preserves stamp ancestry, skips an already stamped version and never forces the release ref", () => {
  const mark = jobs.get("mark") ?? "";
  const initialParents = mark.indexOf('parents=$(jq -n --arg sha "$SHA" \'[$sha]\')');
  const lookup = mark.indexOf('if release_sha=$(gh api "repos/$GH_REPO/git/ref/heads/release"');
  assert(initialParents >= 0 && lookup > initialParents);
  assert.match(
    mark,
    /if \[ -n "\$release_version" \]; then[\s\S]*?parents=\$\(jq -n --arg sha "\$SHA" --arg released "\$release_sha" '\[\$sha, \$released\]'\)\s+fi/,
  );
  assert.match(
    mark,
    /if \[ "\$source_sha" = "\$SHA" \] && \[ "\$release_version" = "\$VERSION" \]; then\s+echo "release already carries \$VERSION"\s+exit 0/,
  );
  const skip = mark.indexOf('echo "release already carries $VERSION"');
  const comparison = mark.indexOf('gh api "repos/$GH_REPO/compare/$source_sha...$SHA" --jq .status');
  const commit = mark.indexOf('gh api --method POST "repos/$GH_REPO/git/commits"');
  assert(comparison > skip && commit > comparison);
  assert(!mark.includes("/compare/$release_sha..."));
  assert.match(
    mark,
    /if \[ "\$comparison" != ahead \] && \[ "\$comparison" != identical \]; then\s+echo "release is ahead of or diverged from \$SHA; refusing a stale run" >&2\s+exit 1/,
  );
  assert.match(
    mark,
    /elif grep -q 'HTTP 404' "\$RUNNER_TEMP\/branch-error"; then\s+release_sha=""\s+else\s+cat "\$RUNNER_TEMP\/branch-error" >&2\s+exit 1/,
  );
  assert.match(
    mark,
    /echo "Stamp commit: \$stamp"\s+if \[ -n "\$release_sha" \]; then\s+gh api --method PATCH "repos\/\$GH_REPO\/git\/refs\/heads\/release" -f "sha=\$stamp" -F force=false\s+else\s+gh api --method POST "repos\/\$GH_REPO\/git\/refs" -f ref=refs\/heads\/release -f "sha=\$stamp"/,
  );
  assert(!/force=true|--force/.test(mark));
});
