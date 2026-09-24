import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createCodexArtifactStager } from "./codex-app-server/artifact-stager.js";
import { resolveCodexExecutionArtifact, stageCodexExecutionArtifact } from "./codex-app-server/artifact-identity.js";
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
}): Promise<{ entrypointPath: string; reportedVersion: string | null }> {
  const artifact = await resolveCodexExecutionArtifact(resolveCodexExecutablePath(input.environment ?? process.env));
  const staged = await stageCodexExecutionArtifact({ artifact, stateRoot: input.stateRoot });
  const helper = input.readbackHelperBytes ?? await readFile(READBACK_HELPER);
  if (createHash("sha256").update(helper).digest("hex") !== CODEX_ARTIFACT_READBACK_HELPER_SHA256
    && input.readbackHelperBytes === undefined) {
    throw new Error("codex-artifact-readback-helper-integrity-mismatch");
  }
  const stagedResult = await createCodexArtifactStager({
    docker: input.docker,
    readbackHelperBytes: helper,
    createId: input.createId
  }).stageIntoRunningContainer({
    containerId: input.containerId,
    staged,
    destinationRoot: `/opt/devspace/codex-artifact/${artifact.closureDigest}`
  });
  return { entrypointPath: stagedResult.entrypointPath, reportedVersion: artifact.packageVersion };
}
