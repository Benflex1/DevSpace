import type { CodexCodeModeHostHandle } from "./code-mode-host.js";
import type { CodexExecServerHandle } from "./exec-server.js";
import type { CodexNativeAppServerHandle } from "./native-app-server.js";
import type { CodexEffectivePolicyProof } from "./remote-policy.js";

export type CodexSplitForbiddenLocalPath =
  | "local-environment"
  | "shell"
  | "command-hook"
  | "legacy-notify"
  | "local-mcp-stdio"
  | "local-http-helper"
  | "unsafe-plugin-maintenance"
  | "program-executor"
  | "shared-app-server-daemon"
  | "danger-full-access"
  | "sandbox-bypass"
  | "remote-local-fallback";

export interface CodexSplitRemoteAdmissionInput {
  readonly effectivePolicy: CodexEffectivePolicyProof;
  readonly execServer: CodexExecServerHandle | null;
  readonly codeModeHost: CodexCodeModeHostHandle | null;
  readonly appServer: CodexNativeAppServerHandle | null;
  readonly forbiddenPaths: readonly CodexSplitForbiddenLocalPath[];
  readonly localEnvironmentAvailable: false;
}

const EXPECTED_EXEC_HOST = "codex-executor" as const;
const EXPECTED_CODE_MODE_HOST = "codex-code-mode-host" as const;
const EXPECTED_SOCKET = "/codex-home/app-server-control/app-server-control.sock" as const;

function reject(reason: string): never {
  throw new Error(reason);
}

function assertEffectivePolicy(policy: CodexEffectivePolicyProof): void {
  if (policy.nativeConfig !== "managed" || policy.projectConfig !== "cannot-override") {
    reject("codex-split-effective-policy");
  }
  if (policy.effective.enabled !== true || policy.effective.hostEnabled !== true
    || policy.effective.disableInProcessFallback !== true
    || policy.effective.remoteHostUrl !== "http://codex-code-mode-host:4546") {
    reject("codex-split-code-mode-policy");
  }
}

function assertExecServer(handle: CodexExecServerHandle): void {
  if (handle.executorContainerId.length === 0 || handle.execId.length === 0
    || !Number.isSafeInteger(handle.serverPid) || handle.serverPid < 1
    || handle.endpoint.endpointHost !== EXPECTED_EXEC_HOST
    || handle.endpoint.endpointUrl !== `ws://${EXPECTED_EXEC_HOST}:${handle.endpoint.endpointPort}`
    || handle.endpoint.security === undefined) {
    reject("codex-split-exec-server");
  }
}

function assertCodeModeHost(handle: CodexCodeModeHostHandle): void {
  if (handle.executorContainerId.length === 0 || handle.execId.length === 0
    || !Number.isSafeInteger(handle.serverPid) || handle.serverPid < 1
    || handle.endpoint.host !== EXPECTED_CODE_MODE_HOST
    || handle.endpoint.url !== `http://${EXPECTED_CODE_MODE_HOST}:${handle.endpoint.port}`
    || handle.endpoint.listenUrl !== `grpc://0.0.0.0:${handle.endpoint.port}`) {
    reject("codex-split-code-mode-host");
  }
}

function assertAppServer(handle: CodexNativeAppServerHandle, expectedCodeModeHostUrl: string): void {
  if (handle.controlContainerId.length === 0 || handle.execId.length === 0
    || !Number.isSafeInteger(handle.serverPid) || handle.serverPid < 1
    || handle.socketPath !== EXPECTED_SOCKET
    || handle.homeIdentity.trim() === ""
    || handle.codeModeHostUrl !== expectedCodeModeHostUrl) {
    reject("codex-split-app-server");
  }
}

export function assertCodexSplitRemoteAdmission(input: CodexSplitRemoteAdmissionInput): void {
  assertEffectivePolicy(input.effectivePolicy);
  if (input.localEnvironmentAvailable !== false) reject("codex-split-local-environment");
  const forbidden = input.forbiddenPaths[0];
  if (forbidden !== undefined) reject(`codex-split-forbidden-${forbidden}`);
  if (input.execServer === null) reject("codex-split-exec-server");
  if (input.codeModeHost === null) reject("codex-split-code-mode-host");
  if (input.appServer === null) reject("codex-split-app-server");
  assertExecServer(input.execServer);
  assertCodeModeHost(input.codeModeHost);
  assertAppServer(input.appServer, input.effectivePolicy.effective.remoteHostUrl);
  if (input.execServer.executorContainerId !== input.codeModeHost.executorContainerId) {
    reject("codex-split-service-container");
  }
  if (input.execServer.endpoint.executionNetworkId !== input.codeModeHost.endpoint.networkId) {
    reject("codex-split-service-network");
  }
}
