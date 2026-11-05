import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";

const globalSetup = fileURLToPath(new URL("./test/global-setup.ts", import.meta.url));
const isolationTest = fileURLToPath(new URL("./test/state-isolation.test.ts", import.meta.url));
const launcherTest = fileURLToPath(new URL("./test/launcher.test.ts", import.meta.url));
const skillsTest = fileURLToPath(new URL("./test/skills.test.ts", import.meta.url));
// nodejs/node#66366: remove once the Node 24 backport ships.
const execArgv = process.versions.node.split(".")[0] === "24" ? ["--no-wasm-code-gc"] : [];

export default defineConfig({
  test: {
    fileParallelism: process.env.EMEND_BENCH !== "1",
    projects: [
      // Only pnpm bench opts in; ordinary and sharded runs never discover this project.
      ...(process.env.EMEND_BENCH === "1"
        ? [
            {
              test: {
                name: "bench",
                execArgv,
                environment: "node",
                globalSetup,
                include: ["apps/**/*.bench.test.ts", "packages/**/*.bench.test.ts"],
                testTimeout: 300_000,
                hookTimeout: 300_000,
                disableConsoleIntercept: true,
              },
            },
          ]
        : []),
      ...["packages/contract", "packages/core", "apps/emend"].map((root) => ({
        test: {
          name: root,
          execArgv,
          root,
          environment: "node",
          globalSetup,
          include: ["src/**/*.test.ts", isolationTest, ...(root === "apps/emend" ? [launcherTest, skillsTest] : [])],
          exclude: [...configDefaults.exclude, "**/*.bench.test.ts"],
        },
      })),
      {
        oxc: { jsx: { runtime: "automatic" } },
        define: { __EMEND_VERSION__: JSON.stringify("0.0.0-test") },
        test: {
          name: "apps/web",
          execArgv,
          root: "apps/web",
          environment: "happy-dom",
          globalSetup,
          setupFiles: [fileURLToPath(new URL("./apps/web/src/test/setup.ts", import.meta.url))],
          include: ["src/**/*.test.{ts,tsx}", isolationTest],
          exclude: [...configDefaults.exclude, "**/*.bench.test.ts"],
        },
      },
    ],
  },
});
