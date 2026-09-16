import { PassThrough } from "node:stream";
import { expect, test } from "vitest";
import {
  startNativeCodexPty
} from "./native-pty.js";
import type { CodexControlSidecarBinding } from "./control-sidecar.js";
import { DockerEngineClient, type DockerExecInspection } from "../docker-runtime.js";

const sessionId = "018f0f00-0000-7000-8000-000000000010";
const endpoint = {
  endpointUrl: "ws://codex-executor:4545", endpointHost: "codex-executor" as const, endpointPort: 4545,
  security: "private-network-only" as const, authenticationEvidence: "absent" as const, credential: null,
  workspaceId: "018f0f00-0000-7000-8000-000000000002", generation: 1, executionNetworkId: "execution-id"
};
const environment = {
  CODEX_HOME: "/codex-home", HOME: "/codex-home", CODEX_EXEC_SERVER_URL: endpoint.endpointUrl
};
const remote = {
  environment, launchArguments: ["-c", "notify=[]"] as const,
  managedPolicy: {
    mechanism: "0.153.4-managed-requirements" as const,
    requirementsPath: "/etc/codex/requirements.toml", mountTarget: "/etc/codex/requirements.toml" as const,
    environment, forbiddenPaths: [] as const, projectLayerOverrideProof: "cannot-override" as const
  },
  endpoint, environmentId: "remote", logicalCwd: "/workspace" as const, workspaceRoots: ["/workspace"] as ["/workspace"],
  localEnvironmentAvailable: false as const, unifiedExecRequired: true as const
};
const control = {
  containerId: "control-id", containerName: "codex-control", imageId: `sha256:${"a".repeat(64)}`,
  policy: {
    remote, environment, workingDirectory: "/workspace" as const,
    physicalWorkspaceMounts: [] as const, physicalGitMounts: [] as const,
    artifact: { launcherPath: "/opt/devspace/codex-launcher/codex" },
    network: {}, mounts: [], networkAttachments: [], forwardingDisabled: true as const, proxyProcesses: [] as const
  }
} as unknown as CodexControlSidecarBinding;

function inspection(id: string): DockerExecInspection {
  return { ID: id, Running: true, ExitCode: null, ContainerID: "control-id", Pid: 321 };
}

test("attaches a raw native TUI PTY with exact remote CWD and no input relay", async () => {
  const calls: Array<{ readonly kind: string; readonly value: unknown }> = [];
  const stream = new PassThrough();
  const docker = new class extends DockerEngineClient {
    constructor() { super("/fixture.sock"); }
    override createExec(containerId: string, input: Parameters<DockerEngineClient["createExec"]>[1]): Promise<string> {
      calls.push({ kind: "create", value: { containerId, input } }); return Promise.resolve("exec-id");
    }
    override startExecAttached(execId: string, tty: boolean): Promise<PassThrough> {
      calls.push({ kind: "start", value: { execId, tty } }); return Promise.resolve(stream);
    }
    override resizeExec(execId: string, columns: number, rows: number): Promise<void> {
      calls.push({ kind: "resize", value: { execId, columns, rows } }); return Promise.resolve();
    }
    override inspectExec(execId: string): Promise<DockerExecInspection> {
      calls.push({ kind: "inspect", value: execId }); return Promise.resolve(inspection(execId));
    }
  }();
  const pty = await startNativeCodexPty({
    docker, control, executablePath: "/opt/devspace/codex-launcher/codex", resumeSessionId: null,
    environment, columns: 120, rows: 40
  });
  expect(pty).toMatchObject({ containerId: "control-id", execId: "exec-id", command: ["/opt/devspace/codex-launcher/codex"], workingDirectory: "/workspace", stream });
  expect(calls).toEqual([
    { kind: "create", value: { containerId: "control-id", input: {
      command: ["/opt/devspace/codex-launcher/codex"], workingDirectory: "/workspace", environment,
      attachStdin: true, tty: true
    } } },
    { kind: "start", value: { execId: "exec-id", tty: true } },
    { kind: "resize", value: { execId: "exec-id", columns: 120, rows: 40 } }
  ]);
  await pty.resize(100, 30);
  expect(calls.at(-1)).toEqual({ kind: "resize", value: { execId: "exec-id", columns: 100, rows: 30 } });
  await expect(pty.inspect()).resolves.toMatchObject({ ID: "exec-id", ContainerID: "control-id" });
  expect(calls.at(-1)).toEqual({ kind: "inspect", value: "exec-id" });
});

test("uses only the native resume argv and rejects local or hidden execution inputs", async () => {
  const calls: unknown[] = [];
  const docker = new class extends DockerEngineClient {
    constructor() { super("/fixture.sock"); }
    override createExec(_containerId: string, input: Parameters<DockerEngineClient["createExec"]>[1]): Promise<string> {
      calls.push(input); return Promise.resolve("exec-id");
    }
    override startExecAttached(): Promise<PassThrough> { return Promise.resolve(new PassThrough()); }
    override resizeExec(): Promise<void> { return Promise.resolve(); }
  }();
  const pty = await startNativeCodexPty({
    docker, control, executablePath: "/opt/devspace/codex-launcher/codex", resumeSessionId: sessionId,
    environment, columns: 80, rows: 24
  });
  expect((calls[0] as { readonly command: readonly string[] }).command).toEqual([
    "/opt/devspace/codex-launcher/codex", "resume", sessionId
  ]);
  await expect(pty.resize(0, 24)).rejects.toThrow("native-pty-size");
  await expect(startNativeCodexPty({
    docker, control, executablePath: "/bin/sh" as unknown as "/opt/devspace/codex-launcher/codex", resumeSessionId: null, environment, columns: 80, rows: 24
  })).rejects.toThrow("native-pty-executable");
  await expect(startNativeCodexPty({
    docker, control, executablePath: "/opt/devspace/codex-launcher/codex", resumeSessionId: "not-a-uuid", environment, columns: 80, rows: 24
  })).rejects.toThrow("native-pty-session");
  await expect(startNativeCodexPty({
    docker, control, executablePath: "/opt/devspace/codex-launcher/codex", resumeSessionId: null,
    environment: { ...environment, DEVSPACE_PROMPT: "hidden" }, columns: 80, rows: 24
  })).rejects.toThrow("native-pty-environment");
  await expect(startNativeCodexPty({
    docker, control, executablePath: "/opt/devspace/codex-launcher/codex", resumeSessionId: null,
    environment, columns: 80, rows: 24, prompt: "run this" } as unknown as Parameters<typeof startNativeCodexPty>[0]
  )).rejects.toThrow("native-pty-input");
  expect(JSON.stringify(calls)).not.toContain("dangerously-bypass-approvals-and-sandbox");
});

test("rejects a missing remote-only policy before creating a PTY", async () => {
  const docker = new class extends DockerEngineClient {
    constructor() { super("/fixture.sock"); }
    override createExec(): Promise<string> { throw new Error("must-not-create"); }
  }();
  const invalid = {
    ...control,
    policy: { ...control.policy, remote: { ...remote, localEnvironmentAvailable: true as unknown as false } }
  } as unknown as CodexControlSidecarBinding;
  await expect(startNativeCodexPty({
    docker, control: invalid, executablePath: "/opt/devspace/codex-launcher/codex", resumeSessionId: null,
    environment, columns: 80, rows: 24
  })).rejects.toThrow("native-pty-remote-policy");
});
