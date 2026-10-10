import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { createCodexArtifactStager } from "./codex-app-server/artifact-stager.js";
import { resolveCodexExecutionArtifact, stageCodexExecutionArtifact } from "./codex-app-server/artifact-identity.js";
import {
  codexArtifactStagingDiagnostic,
  codexArtifactStagingTiming,
  type CodexArtifactStagingDiagnostic,
  type CodexArtifactStagingPhase,
  type CodexArtifactStagingTiming
} from "./codex-app-server/artifact-staging-diagnostics.js";
import { resolveCodexExecutablePath } from "./codex-executable-resolution.js";
import { CODEX_ARTIFACT_READBACK_HELPER_SHA256 } from "./codex-native-helper-identity.js";
import type { DockerEngineClient } from "./docker-runtime.js";

const READBACK_HELPER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist/native/codex-artifact-readback");

export async function stageAgentCodexIntoContainer(input: {
  docker: DockerEngineClient;
  containerId: string;
  stateRoot: string;
  createId: () => string;
  environment?: NodeJS.ProcessEnv;
  readbackHelperBytes?: Uint8Array;
  onStagingDiagnostic?: (diagnostic: CodexArtifactStagingDiagnostic) => void;
  onStagingTiming?: (timing: CodexArtifactStagingTiming) => void;
}): Promise<{ entrypointPath: string; reportedVersion: string | null }> {
  let artifactLayout: Parameters<typeof codexArtifactStagingDiagnostic>[0]["artifactLayout"] = "unknown";
  const runPhase = async <T>(phase: CodexArtifactStagingPhase, operation: () => Promise<T>,
    cacheState?: (result: T) => CodexArtifactStagingTiming["cacheState"]): Promise<T> => {
    const startedAt = performance.now();
    try {
      const result = await operation();
      const reportedCacheState = cacheState?.(result);
      try {
        input.onStagingTiming?.(codexArtifactStagingTiming({
          phase, containerId: input.containerId, artifactLayout, elapsedMs: performance.now() - startedAt,
          outcome: "success", ...(reportedCacheState === undefined ? {} : { cacheState: reportedCacheState })
        }));
      } catch { /* private timing must not change the staging outcome */ }
      return result;
    }
    catch (error) {
      try {
        input.onStagingTiming?.(codexArtifactStagingTiming({
          phase, containerId: input.containerId, artifactLayout, elapsedMs: performance.now() - startedAt,
          outcome: "failure"
        }));
      } catch { /* private timing must not change the staging outcome */ }
      try {
        input.onStagingDiagnostic?.(codexArtifactStagingDiagnostic({
          phase, error, containerId: input.containerId, artifactLayout, elapsedMs: performance.now() - startedAt
        }));
      } catch { /* private diagnostics must not change the staging outcome */ }
      throw error;
    }
  };
  const artifact = await runPhase("artifact-resolution", async () => await resolveCodexExecutionArtifact(
    resolveCodexExecutablePath(input.environment ?? process.env)
  ));
  artifactLayout = artifact.layout;
  const staged = await runPhase("agent-side-stage-copy",
    async () => await stageCodexExecutionArtifact({ artifact, stateRoot: input.stateRoot }),
    (result) => result.cacheState);
  const helper = await runPhase("readback-helper-load", async () => input.readbackHelperBytes ?? await readFile(READBACK_HELPER));
  if (createHash("sha256").update(helper).digest("hex") !== CODEX_ARTIFACT_READBACK_HELPER_SHA256
    && input.readbackHelperBytes === undefined) {
    const error = new Error("codex-artifact-readback-helper-integrity-mismatch");
    try {
      input.onStagingDiagnostic?.(codexArtifactStagingDiagnostic({
        phase: "readback-helper-integrity", error, containerId: input.containerId,
        artifactLayout, elapsedMs: 0
      }));
    } catch { /* private diagnostics must not change the staging outcome */ }
    throw error;
  }
  const stagedResult = await createCodexArtifactStager({
    docker: input.docker,
    readbackHelperBytes: helper,
    createId: input.createId,
    ...(input.onStagingDiagnostic === undefined ? {} : { onFailure: input.onStagingDiagnostic }),
    ...(input.onStagingTiming === undefined ? {} : { onTiming: input.onStagingTiming })
  }).stageIntoRunningContainer({
    containerId: input.containerId,
    staged,
    destinationRoot: `/opt/devspace/codex-artifact/${artifact.closureDigest}`
  });
  return { entrypointPath: stagedResult.entrypointPath, reportedVersion: artifact.packageVersion };
}
