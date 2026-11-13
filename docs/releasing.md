# Releasing emend

This page is for maintainers. GitHub Actions releases `@shllg/emend` and moves the Claude Code
marketplace branch. Nothing is committed back to main. The `release` branch gets one stamp commit
per release.

## Versioning

Releases use plain `x.y.z` versions, without prerelease or build metadata. The server accepts only
that form in the CLI client header.

The previous release is the highest plain `v<x.y.z>` tag merged into the selected main commit.
Non-merge commits since that tag count only when they touch a shipped path and their Conventional
Commit type is neither `test` nor `ci`. Merge wrappers never count. `SHIPPED_PATHS` in
`scripts/release.ts` is the source of truth: it covers the apps, packages, plugin and marketplace,
user setup and usage docs, README, license, and root package, lockfile, workspace, TypeScript config
and packing-hook files.

- **Patch** (`0.1.1`): fixes, performance work and other counted changes without a feature or
  breaking change.
- **Minor** (`0.2.0`): any counted `feat` commit or breaking change. A `!` after the type/scope or
  a `BREAKING CHANGE:` footer marks a breaking change. Before 1.0, breaking changes are minor bumps.
- Manual `patch` or `minor` overrides the automatic choice, but `patch` refuses a counted breaking
  change. A new version needs a counted commit. When resuming an unfinished release, the existing
  tag fixes the version and any manual `--bump` is ignored.
- **`MIN_CLIENT_VERSION`** in `packages/contract/src/api.ts` may name only an already-released
  version. `plan` refuses a value without a reachable release tag, or one greater than the planned
  version. Release support for a new client version before raising this floor.
- **Breaking API change**: it goes to `/api/v2`. `/api/v1` stays additive.

Before planning a new version, the planner checks whether the newest tag's version is on npm and
whether `origin/release` contains its commit. If either is incomplete, it attempts to resume that
tag, using the highest plain tag below it merged into HEAD as the previous release. Notes cover
only the counted commits between that previous tag and the resumed tag. An unpublished tag can
resume only from a run at its own commit, to preserve npm provenance. A published tag can resume
marking from a later HEAD. The planner refuses if the release source commit is ahead of or diverged
from the planned commit, or `release` already holds an unpublished tag's commit. The source is the
release head's first parent when its plugin manifest carries a version. Otherwise it is the head
itself. A release head without `plugin/.claude-plugin/plugin.json`, or with a version that is not
a plain `x.y.z` string, refuses planning.

Once the newest tag is published and contained by `release`, no counted commits means nothing to
release. An existing target tag or npm version refuses a new version. Release notes group counted
breaking changes, features, fixes and performance work; other counted changes produce a maintenance
note when no such groups exist.

## How a release happens

Once enabled, the **Release** workflow runs nightly at **02:00 UTC**, on the upstream repository's
`main` branch. Until the owner completes setup and sets the repository variable `RELEASE_ENABLED`
to `true`, neither nightly nor manual runs do anything. It plans new versions when shipped changes
have landed and finishes interrupted releases. Publishing is fully automatic: a shipped change
pushed to main reaches npm by the next nightly when the gate and publishing succeed. GitHub can
delay scheduled runs and pauses scheduled workflows after 60 days without repository activity.

To run it manually, choose **Actions > Release > Run workflow** on `main`, with a bump of `auto`,
`patch` or `minor`. Or run:

```sh
gh workflow run release.yml -f bump=auto
```

To rehearse, select `dry_run` in the UI or run:

```sh
gh workflow run release.yml -f bump=auto -f dry_run=true
```

A dry run plans, verifies, builds, checks and uploads the tarball. Its summary says which version
would be released and shows the notes. It does not tag, publish or move the marketplace branch.
Scheduled runs use `auto` with `dry_run=false`. Runs share one concurrency group and never cancel
an in-progress release.

1. **plan** reads full history, tags and `origin/release`. It checks npm and the release branch
   before choosing a new version or resuming the newest tag's peeled commit. It records the
   previous tag, full SHA and whether this is a resume, uploads the notes and writes the Actions
   summary. When it plans a release, it also writes stamped plugin and marketplace manifests from
   the planned commit and uploads them as `release-manifests`.
2. **verify** checks that SHA through the shared verify workflow: `verify:static`, `verify:test`,
   `verify:build` and `verify:harness` run in parallel on Node 24 and 26, with
   4 Vitest shards per Node version. These are the same checks as the local `pnpm verify` gate.
   `pnpm bench` prints non-gating JSON lines with no timing assertions; CI does not run it.
   `SYNC_BASE` is the previous release tag, so the sync check covers all commits being released.
3. **build** installs from the frozen lockfile on Node 26, stamps the version into the build
   checkout, builds and packs with pnpm. The root pnpmfile strips private development dependencies;
   the prepack hook refuses npm packing. `check:package --tarball` checks that exact tarball. The
   job uploads it with its SHA-512 integrity and file name.
4. **tag** checks the live release source is an ancestor of or equal to the planned SHA, including
   on reruns that reuse old plan outputs. It reads the plugin manifest at the release head to
   identify a stamp and resolve its first parent. It then creates the lightweight `v<version>` tag.
   An existing lightweight or annotated tag at that same commit is accepted; a different target fails.
5. **publish** runs in the `npm` environment on a GitHub-hosted runner, with only `id-token: write`.
   It checks out no repository code and runs no pnpm. It downloads the tarball, checks its integrity
   and requires npm CLI >= 11.5.1. It publishes with
   `npm publish --ignore-scripts --access public <tarball>` using trusted publishing (OIDC, no npm
   token); npm generates provenance automatically. Publishing requires the workflow run's commit
   to equal the planned SHA. An already-published version skips publishing when its integrity
   matches. A mismatch is accepted only on a resume, whose rebuilt tarball may differ from the
   earlier build; otherwise it fails. Empty registry output also fails. The downloaded artifact
   must always match this run's build integrity. It then polls npm every 20 seconds, for up to
   15 minutes, until the version is visible.
6. **mark** first creates a GitHub Release with the saved notes and verified tag, unless that
   release already exists. It checks the stamped manifests against the tagged commit. Each must
   be one JSON document equal to its original with only the release version added, and the original
   must carry no version. It refuses a version that is not higher than the one `release` carries,
   unless `release` already carries this version for this commit, which succeeds without moving
   anything. It creates a stamp commit through the Git Data API, using the tagged tree with those
   two files replaced. Its first parent is the tagged commit. Its second parent is the previous
   release head when that head is a stamp commit. It then moves `release` to the stamp without
   force, creating the branch if missing. A non-fast-forward fails, leaving the release notes
   available. Plugin users therefore update only after npm is ready.

## Version in the repository

The committed version in `apps/emend/package.json` and `apps/emend/src/version.ts` stays as a floor.
CI stamps the real release version into its build; it never commits those build files or updates
`CHANGELOG.md`. From 0.1.1 onward, release notes live in GitHub Releases.

`pnpm install:local` resolves HEAD once to a full SHA, exports that commit into a temporary folder,
and stamps the highest plain `v<x.y.z>` tag merged into that SHA when it is newer than the committed
version. Non-plain tags are ignored. The installed version, source and printed commit stay together
even if HEAD moves during the install. With no reachable plain tag, it keeps the committed version.
It never stamps the source checkout. Fetch tags before installing if the checkout is missing
recent releases.

On main, `plugin/.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json` carry no version.
`check:package` enforces this, and the skills test also checks the plugin manifest. A local checkout
therefore still tracks commits. On `release`, each stamp puts the release version directly after
the top-level name in both manifests. Claude Code shows that version. Every release is an update
because every release bumps it. The marketplace plugin entry carries no version: `plugin.json`
wins, and `claude plugin validate` warns when both are set (see the
[marketplace reference](https://code.claude.com/docs/en/plugins/marketplace-reference)).
`check:package` also checks the installed CLI
version; `version.test.ts` checks that the two CLI version literals agree.

## One-time owner setup

1. Keep the GitHub repository public and create the GitHub environment **npm**, limited to the
   **main** branch, without required reviewers or an approval gate. The release workflow's publish
   job names this environment.
2. Create two rulesets: one for branch **release** and one for tags `v*`. Both block force pushes
   and deletions. Enable **Require signed commits** on the `release` ruleset. The branch takes
   main's signed commits and stamp commits that GitHub signs for the workflow token. The workflow
   sends no custom author or committer. Allow the workflow to create tags and advance `release`
   normally; whoever can move that branch controls what marketplace users receive.
3. On npmjs.com, add a GitHub Actions trusted publisher for user/organization **shllg**, repository
   **emend**, workflow **release.yml**, environment **npm**. Its first publish must complete within
   **2 days** of creating the trusted publisher. If that deadline passes, delete and recreate the
   trusted publisher before trying again. Keep `apps/emend/package.json`'s `repository.url` as
   `git+https://github.com/shllg/emend.git`, matching that repository. No npm token secret is needed.

   In the trusted publisher's **Allowed actions**, also allow direct publishing with `npm publish`.
   Trusted publishers created after **2026-09-03** allow only `npm stage publish` by default;
   without direct publishing enabled, this workflow's publish job fails. emend uses direct trusted
   publishing with no staged publish and no human approval step.

4. After setup is complete, enable releases with the repository variable:

   ```sh
   gh variable set RELEASE_ENABLED --body true
   ```

   Until this variable is `true`, neither a nightly nor a manual run does anything. Unsetting it,
   or setting it to anything else, stops new runs and also re-runs of `tag`, `publish` and `mark`.

Expect the first real release to stop at the tag or mark step: its range adds
`.github/workflows/release.yml`, and GitHub may refuse that ref update with the workflow token.
Use the owner fallback in Recovery below: create the tag or update `release` by hand, then re-run the
failed jobs.

After the first CI publish succeeds, set the package's publishing access on npmjs.com to
**Require two-factor authentication and disallow tokens**. Trusted publishing continues through
OIDC.

Version 0.1.0 is already on npm and tagged `v0.1.0`; the workflow plans subsequent versions from it.

## Recovery

The planner attempts to resume the newest tag while npm lacks that version or `release` lacks its
commit. It rebuilds the tagged commit, ignores a manual bump, and regenerates notes from the
previous tag through the resumed tag. New commits after that tag wait for a later release.
Marking accepts an existing GitHub Release and branch position.

A tag that never reached npm can be published only from a run at its own commit, because npm
provenance names the publishing run's commit. Use **Re-run failed jobs** on the run that tagged it;
GitHub allows re-runs for **30 days**. The next nightly or manual run can also resume it if main
still points at that commit. If npm already has the version and only marking remains, the next
nightly or manual run can finish it even after main has moved.

If the original run cannot be re-run, the owner pushes a higher lightweight
tag at main's current commit and starts the workflow immediately, before main moves again. Replace
`<x.y.z>` with a plain version higher than the newest tag and absent from npm:

```sh
git fetch origin
git push origin "$(git rev-parse origin/main):refs/tags/v<x.y.z>"
gh workflow run release.yml
```

The stuck tag becomes `previous` for the higher tag. That higher tag's GitHub Release notes list
only commits after the stuck tag, leaving the stuck version's changes out of all release notes.
Edit the higher tag's release notes by hand to include those changes if they matter.

Fix a failure in a resumed run by re-running it, not by adding new commits: the tag pins its source
commit. If a source change is needed, publish it under a higher tag using the procedure above.

Registry HTTP 200 means published and HTTP 404 means missing. Other statuses and network errors
refuse planning; they never trigger a resume. A missing or invalid `origin/release` also refuses:
restore the expected release ref before retrying. The first tag cannot be resumed without an
earlier plain tag for its release boundary.

Never delete or move a pushed release tag. If npm takes longer than 15 minutes to expose a version,
wait and re-run the failed jobs. If the planner or tag job refuses a stale release, or a branch
update is not a fast-forward, investigate the branch history; do not force it. If `release` already
holds a tag's commit but npm lacks its version, investigate that inconsistent state before retrying.

GitHub can refuse a `GITHUB_TOKEN` ref update whose range adds a workflow file. If it refuses tag
creation, the owner creates the tag with the planned SHA and version, then uses **Re-run failed
jobs** on that same run:

```sh
git push origin '<sha>:refs/tags/v<x.y.z>'
```

### A stamp step fails halfway

Nothing moves until the final PATCH updates `release` (or POST creates a missing branch). A stamp
commit created but not reachable from a ref is harmless. Re-running the failed jobs makes a fresh
one. Never force `release`.

If GitHub refuses the workflow token's update of `release`, the owner moves it to the stamp commit
printed in the failed step. Before updating the branch, check that commit:

```sh
gh api repos/shllg/emend/git/commits/<stamp-sha> --jq '.parents[].sha'
gh api repos/shllg/emend/compare/v<x.y.z>...<stamp-sha> --jq '.files[] | .filename, .patch'
```

The parents must list the tagged commit first. The owner confirms that the comparison lists only
`plugin/.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json`, and that each patch adds
only a `"version": "<x.y.z>",` line. Then use a token with the `workflow` scope and drop the extra
scope after the update:

```sh
gh auth refresh -s workflow
gh api --method PATCH repos/shllg/emend/git/refs/heads/release -f sha=<stamp-sha> -F force=false
gh auth refresh --remove-scopes workflow
```

Then re-run the failed jobs. They find `release` already stamped and finish without another move.

## What users see

- **npm users** get the new version through `mise upgrade` or `npm install -g @shllg/emend`.
- **Claude Code users** get the new skills when `release` moves and they update the plugin, or
  when they have plugin auto-update on. After `claude plugin marketplace update emend` and
  `claude plugin update emend@emend`, `claude plugin list` shows the release version.

## Verify a release

```sh
npm view @shllg/emend version --registry=https://registry.npmjs.org/
prefix="$(mktemp -d)"
npm install -g --registry=https://registry.npmjs.org/ --prefix "$prefix" @shllg/emend@<version>
"$prefix/bin/emend" --version
```

The versions must match the released one. Fetch the branch and tags, then check both manifests:

```sh
git fetch origin
git show origin/release:plugin/.claude-plugin/plugin.json
git show origin/release:.claude-plugin/marketplace.json
git rev-parse origin/release^1
git rev-parse 'v<version>^{commit}'
```

Both top-level manifest versions must match the release. The last two commands must print the
same SHA: the stamp's first parent is the tagged commit.

Check npm signatures and provenance from a temporary folder, using the released version:

```sh
verification="$(mktemp -d)"
(
  cd "$verification"
  npm init -y
  npm install --registry=https://registry.npmjs.org/ @shllg/emend@<version>
  npm audit signatures
)
```

The audit must verify the package's registry signature and provenance attestation.
