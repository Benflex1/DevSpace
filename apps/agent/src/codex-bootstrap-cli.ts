import { randomUUID } from "node:crypto";
import { DockerEngineClient, defaultRootlessDockerSocketPath } from "./docker-runtime.js";
import {
  bootstrapCodexCredential,
  codexBootstrapStateRootFromManagedRoot
} from "./codex-credential-bootstrap.js";
import { resolveCodexExecutablePath } from "./codex-executable-resolution.js";

function usageError(message: string): never {
  throw new Error(`codex-bootstrap-usage: ${message}`);
}

const argumentsList = process.argv.slice(2);
if (argumentsList.some((argument) => argument !== "--reauth")) usageError("only --reauth is supported");
const managedRoot = process.env.DEVSPACE_MANAGED_ROOT;
if (managedRoot === undefined || managedRoot.length === 0) usageError("DEVSPACE_MANAGED_ROOT is required");

const docker = new DockerEngineClient(process.env.DEVSPACE_DOCKER_SOCKET_PATH ?? defaultRootlessDockerSocketPath());
const abortController = new AbortController();
const requestShutdown = () => {
  console.error("Codex credential bootstrap cancellation requested; cleaning up.");
  abortController.abort();
};
process.once("SIGINT", requestShutdown);
process.once("SIGTERM", requestShutdown);
try {
  await docker.assertRootlessAvailable();
  const result = await bootstrapCodexCredential({
    stateRoot: codexBootstrapStateRootFromManagedRoot(managedRoot),
    configuredCodexPath: resolveCodexExecutablePath(),
    docker,
    createId: randomUUID,
    reauthenticate: argumentsList.includes("--reauth"),
    signal: abortController.signal,
    ...(process.env.DEVSPACE_CODEX_BOOTSTRAP_IMAGE === undefined ? {} : { imageReference: process.env.DEVSPACE_CODEX_BOOTSTRAP_IMAGE }),
    onDeviceCode: ({ verificationUrl, userCode }) => {
      console.log(`Codex device authentication required. Open ${verificationUrl} and enter ${userCode}.`);
    }
  });
  console.log(`Codex credential authority provisioned using ${result.imageId}.`);
} catch (error) {
  const message = error instanceof Error ? error.message : "codex-bootstrap-failed";
  console.error(`Codex credential bootstrap failed: ${message}`);
  process.exitCode = 1;
} finally {
  process.removeListener("SIGINT", requestShutdown);
  process.removeListener("SIGTERM", requestShutdown);
}
