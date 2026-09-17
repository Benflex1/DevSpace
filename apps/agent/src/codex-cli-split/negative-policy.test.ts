import { expect, test } from "vitest";
import type { CodexCodeModeConfiguration, CodexEffectivePolicyProof } from "./remote-policy.js";
import type { CodexCodeModeHostHandle } from "./code-mode-host.js";
import type { CodexExecServerHandle } from "./exec-server.js";
import type { CodexNativeAppServerHandle } from "./native-app-server.js";
import { assertCodexSplitRemoteAdmission, type CodexSplitForbiddenLocalPath } from "./negative-policy.js";

const codeMode: CodexCodeModeConfiguration = {
  enabled: true,
  hostEnabled: true,
  disableInProcessFallback: true,
  remoteHostUrl: "http://codex-code-mode-host:4546"
};

const effectivePolicy: CodexEffectivePolicyProof = {
  nativeConfig: "managed",
  projectConfig: "cannot-override",
  effective: codeMode,
  forbiddenLocalPaths: [
    "local-environment", "shell", "unified-exec-disabled", "missing-endpoint", "stale-endpoint",
    "code-mode-host-missing", "code-mode-host-stale", "code-mode-fallback-enabled", "embedded-app-server",
    "command-hooks", "legacy-notify", "local-mcp-stdio", "local-http-helper", "unsafe-plugin-maintenance",
    "program-executor", "shared-app-server-daemon", "danger-full-access", "sandbox-bypass", "remote-local-fallback"
  ]
};

const execServer = {
  executorContainerId: "executor-id",
  execId: "exec-server-id",
  endpoint: {
    endpointUrl: "ws://codex-executor:4545",
    endpointHost: "codex-executor",
    endpointPort: 4545,
    security: "private-network-only",
    authenticationEvidence: "absent",
    credential: null,
    workspaceId: "018f0f00-0000-7000-8000-000000000001",
    generation: 1,
    executionNetworkId: "execution-network-id"
  },
  serverPid: 11
} satisfies CodexExecServerHandle;

const codeModeHost = {
  executorContainerId: "executor-id",
  execId: "code-mode-id",
  endpoint: {
    host: "codex-code-mode-host",
    port: 4546,
    url: "http://codex-code-mode-host:4546",
    listenUrl: "grpc://0.0.0.0:4546",
    networkId: "execution-network-id"
  },
  serverPid: 12,
  transportSecurity: "private-network-only"
} satisfies CodexCodeModeHostHandle;

const appServer = {
  controlContainerId: "control-id",
  execId: "app-server-id",
  serverPid: 13,
  socketPath: "/codex-home/app-server-control/app-server-control.sock",
  socketIdentity: { device: "1", inode: "2" },
  homeIdentity: "1:3",
  codeModeHostUrl: "http://codex-code-mode-host:4546",
  transportSecurity: "private-network-only"
} satisfies CodexNativeAppServerHandle;

function input(overrides: Partial<Parameters<typeof assertCodexSplitRemoteAdmission>[0]> = {}) {
  return {
    effectivePolicy,
    execServer,
    codeModeHost,
    appServer,
    forbiddenPaths: [],
    localEnvironmentAvailable: false as const,
    ...overrides
  };
}

test("accepts a complete remote Code Mode admission", () => {
  expect(() => assertCodexSplitRemoteAdmission(input())).not.toThrow();
});

test.each([
  "local-environment", "shell", "command-hook", "legacy-notify", "local-mcp-stdio",
  "local-http-helper", "unsafe-plugin-maintenance", "program-executor", "shared-app-server-daemon",
  "danger-full-access", "sandbox-bypass", "remote-local-fallback"
] satisfies readonly CodexSplitForbiddenLocalPath[])("rejects forbidden local path %s", (forbiddenPath) => {
  expect(() => assertCodexSplitRemoteAdmission(input({ forbiddenPaths: [forbiddenPath] })))
    .toThrow(`codex-split-forbidden-${forbiddenPath}`);
});

test("rejects missing or stale remote service handles", () => {
  expect(() => assertCodexSplitRemoteAdmission(input({ execServer: null }))).toThrow("codex-split-exec-server");
  expect(() => assertCodexSplitRemoteAdmission(input({ codeModeHost: null }))).toThrow("codex-split-code-mode-host");
  expect(() => assertCodexSplitRemoteAdmission(input({ appServer: null }))).toThrow("codex-split-app-server");
});

test("rejects a local effective environment or a non-managed effective policy", () => {
  expect(() => assertCodexSplitRemoteAdmission(input({ localEnvironmentAvailable: true as never })))
    .toThrow("codex-split-local-environment");
  expect(() => assertCodexSplitRemoteAdmission(input({
    effectivePolicy: { ...effectivePolicy, nativeConfig: "unmanaged" as never }
  }))).toThrow("codex-split-effective-policy");
});

test("rejects a Code Mode host or exec endpoint that does not match the admitted remote topology", () => {
  expect(() => assertCodexSplitRemoteAdmission(input({
    codeModeHost: { ...codeModeHost, endpoint: { ...codeModeHost.endpoint, url: "http://other-host:4546" } }
  }))).toThrow("codex-split-code-mode-host");
  expect(() => assertCodexSplitRemoteAdmission(input({
    execServer: { ...execServer, endpoint: { ...execServer.endpoint, endpointUrl: "ws://other-host:4545" } }
  }))).toThrow("codex-split-exec-server");
});
