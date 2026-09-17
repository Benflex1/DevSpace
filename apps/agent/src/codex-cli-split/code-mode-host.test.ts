import { PassThrough } from "node:stream";
import { expect, test } from "vitest";
import { DockerEngineClient, type DockerExecInspection } from "../docker-runtime.js";
import type { CodexProjectExecutorPolicy } from "./project-executor.js";
import type { CodexSplitExecutionNetworkBinding } from "./network.js";
import type { CodexSplitArtifactCapabilities } from "./artifact.js";
import {
  assertCodexCodeModeHostReady,
  buildCodexCodeModeHostPolicy,
  probeCodexCodeModeHostReady,
  startCodexCodeModeHost,
  type CodexCodeModeHostEndpoint,
  type CodexCodeModeHostPolicy
} from "./code-mode-host.js";

const executorContainerId = "executor-container";
const executionNetwork: CodexSplitExecutionNetworkBinding = {
  role: "execution",
  workspaceId: "018f0f00-0000-7000-8000-000000000002",
  generation: 4,
  id: "execution-network-id",
  name: "execution-network",
  controlAlias: "codex-control",
  executorAlias: "codex-executor",
  internal: true,
  defaultRoute: false,
  publishedPorts: []
};
const artifact: CodexSplitArtifactCapabilities = {
  nativeCliPath: "/opt/devspace/codex/bin/codex",
  execServerCapability: "codex-0.153.4-exec-server",
  appServerCapability: "codex-0.153.4-app-server",
  codeModeHostPath: "/opt/devspace/codex/bin/codex-code-mode-host",
  codeModeHostCapability: "codex-0.153.4-code-mode-host",
  closureDigest: "a".repeat(64)
};
const executor = {
  containerId: executorContainerId,
  endpointPort: 4545,
  controlEgressAttached: false,
  policy: {
    artifact: { staged: { artifact: { packageVersion: "0.153.4" } } },
    executionNetwork,
    workingDirectory: "/workspace",
    controlEgressAttached: false,
    endpointPort: 4545,
    codeModeHostPort: 4546
  }
} as unknown as { containerId: string; policy: CodexProjectExecutorPolicy };

const endpoint: CodexCodeModeHostEndpoint = {
  host: "codex-code-mode-host",
  port: 4546,
  url: "http://codex-code-mode-host:4546",
  listenUrl: "grpc://0.0.0.0:4546",
  networkId: executionNetwork.id
};

function policy(overrides: Partial<CodexCodeModeHostPolicy> = {}): CodexCodeModeHostPolicy {
  return {
    executorContainerId,
    executionNetworkId: executionNetwork.id,
    artifact,
    endpoint,
    command: [artifact.codeModeHostPath, "--listen", endpoint.listenUrl],
    environment: {},
    workingDirectory: "/workspace",
    credentialsPresent: false,
    controlEgressAttached: false,
    ...overrides
  };
}

function inspection(id: string, overrides: Partial<DockerExecInspection> = {}): DockerExecInspection {
  return {
    ID: id,
    Running: true,
    ExitCode: null,
    ContainerID: executorContainerId,
    Pid: 42,
    ...overrides
  };
}

function dockerFixture(options: {
  readonly hostInspection?: DockerExecInspection;
  readonly probeInspections?: readonly DockerExecInspection[];
} = {}): DockerEngineClient & { readonly commands: readonly (readonly string[])[] } {
  const commands: string[][] = [];
  let probeIndex = 0;
  const client = new (class extends DockerEngineClient {
    constructor() { super("/fixture.sock"); }
    override createExec(_containerId: string, input: { readonly command: readonly string[] }): Promise<string> {
      commands.push([...input.command]);
      return Promise.resolve(input.command.some((part) => part.includes("grpc.health.v1.Health")) ? "probe-exec" : "host-exec");
    }
    override startExecAttached(): Promise<PassThrough> { return Promise.resolve(new PassThrough()); }
    override inspectExec(id: string): Promise<DockerExecInspection> {
      if (id === "host-exec") return Promise.resolve(options.hostInspection ?? inspection(id));
      const observed = options.probeInspections?.[Math.min(probeIndex++, (options.probeInspections?.length ?? 1) - 1)]
        ?? inspection(id, { Running: false, ExitCode: 0 });
      return Promise.resolve({ ...observed, ID: id });
    }
  })();
  return Object.assign(client, { commands });
}

test("builds a separate native gRPC Code Mode host policy", () => {
  const result = buildCodexCodeModeHostPolicy({ executor, artifact });
  expect(result.endpoint).toEqual(endpoint);
  expect(result.command).toEqual([artifact.codeModeHostPath, "--listen", "grpc://0.0.0.0:4546"]);
  expect(result.workingDirectory).toBe("/workspace");
  expect(result.credentialsPresent).toBe(false);
  expect(result.controlEgressAttached).toBe(false);
});

test("starts the host only with a valid executor process", async () => {
  const result = await startCodexCodeModeHost({ docker: dockerFixture(), policy: policy() });
  expect(result).toMatchObject({
    executorContainerId,
    execId: "host-exec",
    endpoint,
    serverPid: 42,
    transportSecurity: "private-network-only"
  });
});

test("rejects missing helper, malformed listener, credentials, or control egress", async () => {
  await expect(startCodexCodeModeHost({ docker: dockerFixture(), policy: policy({
    artifact: { ...artifact, codeModeHostPath: "" }
  }) })).rejects.toThrow("codex-code-mode-host-helper");
  expect(() => buildCodexCodeModeHostPolicy({
    executor,
    artifact,
    port: 4545
  })).toThrow("codex-code-mode-host-port");
  await expect(startCodexCodeModeHost({ docker: dockerFixture(), policy: policy({
    environment: { CODEX_HOME: "/codex-home" }
  }) })).rejects.toThrow("codex-code-mode-host-credentials");
  await expect(startCodexCodeModeHost({ docker: dockerFixture(), policy: policy({
    controlEgressAttached: true as never
  }) })).rejects.toThrow("codex-code-mode-host-network");
});

test("rejects wrong network, PID, container, and terminal process state", async () => {
  expect(() => buildCodexCodeModeHostPolicy({
    executor,
    artifact
  })).not.toThrow();
  await expect(startCodexCodeModeHost({
    docker: dockerFixture(),
    policy: policy({ endpoint: { ...endpoint, networkId: "wrong" } })
  })).rejects.toThrow("codex-code-mode-host-network");
  await expect(startCodexCodeModeHost({
    docker: dockerFixture({ hostInspection: inspection("host-exec", { Pid: 0 }) }),
    policy: policy()
  })).rejects.toThrow("codex-code-mode-host-process");
  await expect(startCodexCodeModeHost({
    docker: dockerFixture({ hostInspection: inspection("host-exec", { ContainerID: "other" }) }),
    policy: policy()
  })).rejects.toThrow("codex-code-mode-host-process");
  await expect(startCodexCodeModeHost({
    docker: dockerFixture({ hostInspection: inspection("host-exec", { Running: false, ExitCode: 1 }) }),
    policy: policy()
  })).rejects.toThrow("codex-code-mode-host-exited-before-ready");
});

test("uses a bounded native gRPC readiness probe rather than exec-server readyz", async () => {
  const docker = dockerFixture({ probeInspections: [
    inspection("probe-exec", { Running: false, ExitCode: 1 }),
    inspection("probe-exec", { Running: false, ExitCode: 0 })
  ] });
  const handle = {
    executorContainerId,
    execId: "host-exec",
    endpoint,
    serverPid: 42,
    transportSecurity: "private-network-only" as const
  };
  let now = 0;
  await probeCodexCodeModeHostReady({
    docker,
    handle,
    deadlineMs: 100,
    pollIntervalMs: 1,
    now: () => now,
    sleep: (milliseconds) => { now += milliseconds; return Promise.resolve(); }
  });
  expect(docker.commands.some((command) => command.some((part) => part.includes("grpc.health.v1.Health")))).toBe(true);
  expect(docker.commands.flat()).not.toContain("/readyz");
});

test("fails closed on a live host readiness timeout", async () => {
  const docker = dockerFixture({ probeInspections: [inspection("probe-exec", { Running: false, ExitCode: 1 })] });
  const handle = { executorContainerId, execId: "host-exec", endpoint, serverPid: 42, transportSecurity: "private-network-only" as const };
  let now = 0;
  await expect(probeCodexCodeModeHostReady({
    docker,
    handle,
    deadlineMs: 3,
    pollIntervalMs: 1,
    now: () => now,
    sleep: (milliseconds) => { now += milliseconds; return Promise.resolve(); }
  })).rejects.toThrow("codex-code-mode-host-not-ready");
});

test("ready assertion validates the host process and performs readiness", async () => {
  const docker = dockerFixture();
  const handle = { executorContainerId, execId: "host-exec", endpoint, serverPid: 42, transportSecurity: "private-network-only" as const };
  await expect(assertCodexCodeModeHostReady({ docker, handle, policy: policy() })).resolves.toBeUndefined();
});
