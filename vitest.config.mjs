import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { expectedPackages } from "./tooling/workspace-graph.mjs";

const rootDirectory = path.dirname(fileURLToPath(import.meta.url));
const workspaceAliases = Object.fromEntries(
  [...expectedPackages].map(([directory, definition]) => [
    definition.name,
    path.resolve(rootDirectory, directory, "src/index.ts")
  ])
);

const testProjectDefinitions = [...expectedPackages].map(([directory, definition]) => ({
  resolve: { alias: workspaceAliases },
  test: {
    name: definition.name,
    include: [`${directory}/src/**/*.test.ts`],
    environment: "node",
    passWithNoTests: false,
    isolate: true,
    fileParallelism: false,
    restoreMocks: true,
    unstubEnvs: true,
    unstubGlobals: true
  }
}));

const expectedTestProjectNames = [...expectedPackages.values()].map((definition) => definition.name);
const configuredTestProjectNames = testProjectDefinitions.map((project) => project.test.name);
const missingTestProjects = expectedTestProjectNames.filter(
  (name) => !configuredTestProjectNames.includes(name)
);
const unexpectedTestProjects = configuredTestProjectNames.filter(
  (name) => !expectedTestProjectNames.includes(name)
);

if (missingTestProjects.length > 0 || unexpectedTestProjects.length > 0) {
  throw new Error(
    `Vitest project structure is invalid; missing: ${missingTestProjects.join(", ") || "none"}; `
    + `unexpected: ${unexpectedTestProjects.join(", ") || "none"}`
  );
}

export default defineConfig({
  resolve: { alias: workspaceAliases },
  test: {
    projects: testProjectDefinitions,
    coverage: {
      provider: "v8",
      reportsDirectory: "coverage",
      include: ["apps/**/src/**/*.ts", "packages/**/src/**/*.ts"],
      exclude: [
        "**/*.test.ts",
        "**/*.spec.ts",
        "**/*.d.ts",
        "**/dist/**",
        "**/node_modules/**",
        "tooling/**",
        "**/*.config.{js,mjs,cjs,ts}",
        "vitest.config.*"
      ]
    }
  }
});
