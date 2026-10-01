import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import type { DockerEngineClient } from "./docker-runtime.js";
import { stageAgentCodexIntoContainer } from "./harness-codex-artifact.js";
import type { CodexArtifactStagingDiagnostic } from "./codex-app-server/artifact-stager.js";
import type { CodexArtifactStagingTiming } from "./codex-app-server/artifact-staging-diagnostics.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
});

test("reports bounded resolution diagnostics without exposing executable paths", async () => {
  const stateRoot = await mkdtemp(path.join(tmpdir(), "devspace-codex-stage-diagnostics-"));
  roots.push(stateRoot);
  const diagnostics: CodexArtifactStagingDiagnostic[] = [];
  const timings: CodexArtifactStagingTiming[] = [];

  await expect(stageAgentCodexIntoContainer({
    docker: {} as DockerEngineClient,
    containerId: "a".repeat(64),
    stateRoot,
    createId: () => "diagnostic",
    environment: { PATH: "" },
    onStagingDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    onStagingTiming: (timing) => timings.push(timing)
  })).rejects.toThrow("CODEX_EXECUTABLE_MISSING");

  expect(diagnostics).toHaveLength(1);
  expect(diagnostics[0]).toMatchObject({
    phase: "artifact-resolution", failureCode: "CODEX_EXECUTABLE_MISSING", errorClass: "Error",
    containerId: "a".repeat(64), artifactLayout: "unknown"
  });
  expect(diagnostics[0]?.elapsedMs).toBeGreaterThanOrEqual(0);
  expect(JSON.stringify(diagnostics)).not.toContain(stateRoot);
  expect(diagnostics[0]).not.toHaveProperty("errorMessage");
  expect(timings).toEqual([expect.objectContaining({ phase: "artifact-resolution", outcome: "failure" })]);
  expect(JSON.stringify(timings)).not.toContain(stateRoot);
});
