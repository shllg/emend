# Develop emend from a checkout

A checkout installs the same way as a release: `pnpm install:local` builds the committed `HEAD` in
a temporary folder, packs it and installs the package. Use a clone that no agent or tool writes to,
review a change before you pull it, and run the command again after each pull.

```sh
pnpm install
pnpm install:local
```

If you linked `apps/emend/bin/emend` into a folder on your `PATH` before (the earlier development
steps and `install.sh` did), remove that link, and stop every emend server that runs from a
checkout: `pgrep -af '[e]mend.mjs serve'` lists them with their paths (`pgrep -lf` on macOS).
Otherwise the commands your agents run, and the server that serves the review app, run the
checkout's build, which agents can change.

With mise on your `PATH`, the package goes to a folder in mise's data folder that `mise link`
registers as `npm:@shllg/emend@local`; pass `--npm` to use `npm install -g` instead. If `emend` is
not on your `PATH` yet, the command prints the folder to add. It also restarts an installed
service, so the new build runs.

For Claude Code, add the checkout as a plugin marketplace instead of the GitHub one, never both:

```text
/plugin marketplace add <path to your checkout>
/plugin install emend@emend
```

Claude Code reads the skills from the checkout's `plugin/` folder, uncommitted changes included. A
pulled change takes effect at the next session start or after `/reload-plugins`. For other agents,
run `emend skills install` once; its links point into the installed package.

`pnpm verify` is the single local gate. It runs `verify:static`, `verify:test`,
`verify:build` and `verify:harness` in order. CI runs those same checks in parallel on Node 24
and 26, with 4 Vitest shards per Node version. `pnpm bench` runs non-gating measurements with
temporary state and prints JSON lines; it has no timing assertions and does not run in CI.
[AGENTS.md](https://github.com/shllg/emend/blob/main/AGENTS.md)
holds the working rules. Maintainers: [releasing.md](../releasing.md) holds the release policy
and checklist.
