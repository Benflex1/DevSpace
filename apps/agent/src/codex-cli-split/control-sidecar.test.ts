import { expect, test } from "vitest";
import {
  assertCodexControlSidecarInspection,
  buildCodexControlSidecarPolicy,
  createCodexControlSidecar,
  type CodexControlSidecarPolicy
} from "./control-sidecar.js";
import type { CodexSplitArtifactBinding } from "./artifact.js";
import type { CodexNativeHomeBinding } from "./native-home.js";
import type { CodexRemoteOnlyConfiguration, CodexManagedPolicyBinding } from "./remote-policy.js";
import type { CodexSplitNetworkBinding } from "./network.js";
import type { CodexSplitTransportBinding } from "./transport.js";
import { DockerEngineClient, type DockerContainerInspection, type DockerImageInspection } from "../docker-runtime.js";

const workspaceId = "018f0f00-0000-7000-0000-000000000002";
const imageId = `sha256:${"a".repeat(64)}`;

const home: CodexNativeHomeBinding = {
  accountBinding: "owner-default",
  homePath: "/srv/devspace/codex-homes/owner-default",
  mountTarget: "/codex-home",
  identity: { device: "1", inode: "2" },
  ownerUid: 1000,
  ownerGid: 1000
};

const network: CodexSplitNetworkBinding = {
  execution: {
    role: "execution", workspaceId, generation: 4, id: "execution-id", name: "codex-execution",
    controlAlias: "codex-control", executorAlias: "codex-executor", internal: true, defaultRoute: false, publishedPorts: []
  },
  controlEgress: {
    role: "control-egress", workspaceId, generation: 4, id: "control-egress-id", name: "codex-control-egress",
    controlAlias: "codex-control", executorAttached: false, internal: false, defaultRoute: true,
    publishedPorts: [], defaultBridgeUsed: false
  }
};

const artifact: CodexSplitArtifactBinding = {
  staged: {
    artifact: {
      configuredPath: "/srv/codex-0.153.4",
      canonicalSourceRoot: "/srv/codex-0.153.4",
      layout: "standalone-package",
      target: { os: "linux", architecture: "x86_64", abi: "musl" },
      packageVersion: "0.153.4",
      entrypoint: { relativePath: "bin/codex", kind: "file", mode: 0o755, linkTarget: null, byteLength: 1, sha256: "b".repeat(64) },
      entries: [{ relativePath: "codex-resources/bwrap", kind: "file", mode: 0o755, linkTarget: null, byteLength: 1, sha256: "c".repeat(64) }],
      entrypointSha256: "b".repeat(64), closureDigest: "d".repeat(64)
    },
    stagingRoot: "/srv/devspace/codex-staging/d",
    entrypointPath: "/srv/devspace/codex-staging/d/bin/codex",
    readbackManifestPath: "/srv/devspace/codex-staging/d/manifest.json"
  },
  packageVersion: "0.153.4",
  closureDigest: "d".repeat(64),
  mountTarget: "/opt/devspace/codex",
  entrypointPath: "/opt/devspace/codex/bin/codex",
  launcherPath: "/opt/devspace/codex-launcher/codex",
  launcherSourceRoot: "/srv/devspace/codex-launchers/d",
  launcherSourcePath: "/srv/devspace/codex-launchers/d/codex"
};

const endpoint: CodexSplitTransportBinding = {
  endpointUrl: "ws://codex-executor:4545",
  endpointHost: "codex-executor",
  endpointPort: 4545,
  security: "private-network-only",
  authenticationEvidence: "absent",
  credential: null,
  workspaceId,
  generation: 4,
  executionNetworkId: network.execution.id
};

const managedPolicy: CodexManagedPolicyBinding = {
  mechanism: "0.153.4-managed-requirements",
  requirementsPath: "/srv/devspace/codex-policies/workspace/requirements.toml",
  mountTarget: "/etc/codex/requirements.toml",
  environment: {
    CODEX_HOME: "/codex-home",
    HOME: "/codex-home",
    CODEX_EXEC_SERVER_URL: endpoint.endpointUrl
  },
  forbiddenPaths: [
    "local-environment", "shell", "unified-exec-disabled", "missing-endpoint", "stale-endpoint",
    "command-hooks", "legacy-notify", "local-mcp-stdio", "local-http-helper", "unsafe-plugin-maintenance",
    "program-executor", "shared-app-server-daemon", "danger-full-access", "sandbox-bypass", "remote-local-fallback"
  ],
  projectLayerOverrideProof: "cannot-override"
};

const remote: CodexRemoteOnlyConfiguration = {
  environment: { ...managedPolicy.environment },
  launchArguments: [],
  managedPolicy,
  endpoint,
  environmentId: "remote",
  logicalCwd: "/workspace",
  workspaceRoots: ["/workspace"],
  localEnvironmentAvailable: false,
  unifiedExecRequired: true,
  codeMode: {
    enabled: true,
    hostEnabled: true,
    disableInProcessFallback: true,
    remoteHostUrl: "http://codex-code-mode-host:4546"
  }
};

const image: DockerImageInspection = {
  Id: imageId, Os: "linux", Architecture: "amd64", Config: { Env: ["PATH=/usr/bin:/bin"] }
};

function dockerImageInspection(policy: CodexControlSidecarPolicy, overrides: Partial<DockerContainerInspection> = {}): DockerContainerInspection {
  return {
    Id: "control-id", Name: "/codex-control", Image: imageId,
    Config: {
      Labels: policy.labels, Image: policy.imageReference, WorkingDir: "/workspace", User: policy.containerUser ?? "",
      Env: Object.entries(policy.environment).map(([name, value]) => `${name}=${value}`),
      Entrypoint: ["/bin/sh", "-c"], Cmd: ["exec sleep 2147483647"]
    },
    State: { Running: true, Status: "running" },
    HostConfig: {
      Privileged: false, PublishAllPorts: false, PidMode: "", IpcMode: "private", UTSMode: "",
      UsernsMode: "", CgroupnsMode: "private", NetworkMode: network.execution.name, PortBindings: {},
      Devices: [], NanoCpus: policy.resources.cpuMillicores * 1_000_000, Memory: policy.resources.memoryBytes,
      PidsLimit: policy.resources.pidLimit, CapAdd: [], CapDrop: ["ALL"], SecurityOpt: ["no-new-privileges:true"],
      AutoRemove: false, ReadonlyRootfs: false, RestartPolicy: { Name: "no", MaximumRetryCount: 0 },
      Binds: [], Mounts: [], Tmpfs: policy.tmpfs, MemorySwap: policy.resources.memoryBytes,
      Sysctls: { "net.ipv4.ip_forward": "0", "net.ipv6.conf.all.forwarding": "0" }
    },
    NetworkSettings: {
      Networks: {
        [network.execution.name]: { NetworkID: network.execution.id, Gateway: "" },
        [network.controlEgress.name]: { NetworkID: network.controlEgress.id, Gateway: "10.0.0.1" }
      }
    },
    Mounts: policy.mounts.map((mount) => ({
      Type: mount.Type, Source: mount.Source, Destination: mount.Target, RW: !mount.ReadOnly,
      Propagation: mount.BindOptions.Propagation
    })),
    ...overrides
  };
}

async function buildPolicy() {
  return await buildCodexControlSidecarPolicy({
    imageReference: "ghcr.io/devspace/codex-control:0.153.4", home, artifact, remote, network
  });
}

test("uses the rootless image-default user for private bind mounts", async () => {
  const policy = await buildPolicy();
  expect(policy.containerUser).toBeNull();
  expect(() => assertCodexControlSidecarInspection({
    container: dockerImageInspection(policy),
    binding: { policy, containerId: "control-id", containerName: "codex-control", imageId }
  })).not.toThrow();
  expect(() => assertCodexControlSidecarInspection({
    container: { ...dockerImageInspection(policy), Config: { ...dockerImageInspection(policy).Config, User: "1000:1000" } },
    binding: { policy, containerId: "control-id", containerName: "codex-control", imageId }
  })).toThrow("codex-control-inspection-policy");
});

function causeMessages(error: unknown): string[] {
  const messages: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current instanceof Error; depth += 1) {
    messages.push(current.message);
    current = (current as Error & { readonly cause?: unknown }).cause;
  }
  return messages;
}

test("builds a control policy with only native home and trusted read-only assets", async () => {
  const policy = await buildPolicy();
  expect(policy.nativeAppServerSocketPath).toBe("/codex-home/app-server-control/app-server-control.sock");
  expect(policy.environment).toEqual(remote.environment);
  expect(policy.workingDirectory).toBe("/workspace");
  expect(policy.physicalWorkspaceMounts).toEqual([]);
  expect(policy.physicalGitMounts).toEqual([]);
  expect(policy.mounts).toEqual(expect.arrayContaining([
    expect.objectContaining({ Source: home.homePath, Target: "/codex-home", ReadOnly: false }),
    expect.objectContaining({ Source: artifact.staged.stagingRoot, Target: "/opt/devspace/codex", ReadOnly: true }),
    expect.objectContaining({ Source: artifact.launcherSourceRoot, Target: "/opt/devspace/codex-launcher", ReadOnly: true }),
    expect.objectContaining({ Source: managedPolicy.requirementsPath, Target: "/etc/codex/requirements.toml", ReadOnly: true })
  ]));
  expect(policy.mounts).not.toEqual(expect.arrayContaining([
    expect.objectContaining({ Target: "/workspace" }),
    expect.objectContaining({ Target: "/codex-home/**" })
  ]));
  expect(policy.networkAttachments).toHaveLength(2);
  expect(policy.networkAttachments.map((entry) => entry.role)).toEqual(["execution", "control-egress"]);
  expect(policy.networkAttachments[0]?.defaultRoute).toBe(false);
  expect(policy.networkAttachments[1]?.defaultRoute).toBe(true);
  expect(policy.forwardingDisabled).toBe(true);
  expect(policy.proxyProcesses).toEqual([]);
});

test("rejects a missing/stale remote policy, workspace mount, and unsafe control network", async () => {
  await expect(buildCodexControlSidecarPolicy({
    imageReference: "ghcr.io/devspace/codex-control:0.153.4", home, artifact,
    remote: { ...remote, environment: { ...remote.environment, CODEX_EXEC_SERVER_URL: "" } }, network
  })).rejects.toThrow(/missing|stale|endpoint/u);
  await expect(buildCodexControlSidecarPolicy({
    imageReference: "ghcr.io/devspace/codex-control:0.153.4", home, artifact,
    remote: { ...remote, logicalCwd: "/project" as "/workspace" }, network
  })).rejects.toThrow("codex-control-working-directory");
  await expect(buildCodexControlSidecarPolicy({
    imageReference: "ghcr.io/devspace/codex-control:0.153.4", home, artifact,
    remote: { ...remote, localEnvironmentAvailable: true as unknown as false }, network
  })).rejects.toThrow("codex-control-remote-policy");
  await expect(buildCodexControlSidecarPolicy({
    imageReference: "ghcr.io/devspace/codex-control:0.153.4", home, artifact,
    remote, network: { ...network, controlEgress: { ...network.controlEgress, defaultBridgeUsed: true as unknown as false } }
  })).rejects.toThrow("codex-control-network");
});

test("inspects exactly two isolated networks and rejects project or routing exposure", async () => {
  const policy = await buildPolicy();
  const binding = { policy, containerId: "control-id", containerName: "codex-control" };
  const bindingWithImage = { ...binding, imageId };
  expect(() => assertCodexControlSidecarInspection({ container: dockerImageInspection(policy), binding: bindingWithImage })).not.toThrow();
  expect(() => assertCodexControlSidecarInspection({
    container: { ...dockerImageInspection(policy), Mounts: [...dockerImageInspection(policy).Mounts, {
      Type: "bind", Source: "/project", Destination: "/workspace", RW: true, Propagation: "rprivate"
    }] }, binding: bindingWithImage
  })).toThrow("codex-control-inspection-policy");
  expect(() => assertCodexControlSidecarInspection({
    container: {
      ...dockerImageInspection(policy),
      NetworkSettings: { Networks: {
        [network.execution.name]: { NetworkID: network.execution.id },
        [network.controlEgress.name]: { NetworkID: network.controlEgress.id },
        "unrelated": { NetworkID: "unrelated-id" }
      } }
    }, binding: bindingWithImage
  })).toThrow("codex-control-inspection-policy");
  expect(() => assertCodexControlSidecarInspection({
    container: { ...dockerImageInspection(policy), HostConfig: { ...dockerImageInspection(policy).HostConfig, CapAdd: ["NET_ADMIN"] } }, binding: bindingWithImage
  })).toThrow("codex-control-inspection-policy");
});

test("accepts the two expected control networks in either Docker map-key order", async () => {
  const policy = await buildPolicy();
  const binding = { policy, containerId: "control-id", containerName: "codex-control", imageId };
  const base = dockerImageInspection(policy);
  expect(() => assertCodexControlSidecarInspection({
    container: {
      ...base,
      NetworkSettings: { Networks: {
        [network.controlEgress.name]: { NetworkID: network.controlEgress.id },
        [network.execution.name]: { NetworkID: network.execution.id }
      } }
    }, binding
  })).not.toThrow();
});

test("creates only an inspected explicit control image and preserves native home on failure", async () => {
  const calls: Array<{ readonly kind: string; readonly value: unknown }> = [];
  const policy = await buildPolicy();
  const docker = new class extends DockerEngineClient {
    constructor() { super("/fixture.sock"); }
    override ensureImage(reference: string): Promise<void> { calls.push({ kind: "ensure", value: reference }); return Promise.resolve(); }
    override inspectImage(): Promise<DockerImageInspection> { calls.push({ kind: "image", value: null }); return Promise.resolve(image); }
    override createCodexSplitContainer(_name: string, input: unknown): Promise<string> {
      calls.push({ kind: "create", value: input }); return Promise.resolve("control-id");
    }
    override startContainer(id: string): Promise<void> { calls.push({ kind: "start", value: id }); return Promise.resolve(); }
    override inspectContainer(): Promise<DockerContainerInspection> {
      calls.push({ kind: "inspect", value: null }); return Promise.resolve(dockerImageInspection(policy));
    }
  }();
  const binding = await createCodexControlSidecar({ docker, policy, name: "codex-control" });
  expect(binding).toMatchObject({ containerId: "control-id", containerName: "codex-control" });
  expect(calls.map((call) => call.kind)).toEqual(["ensure", "image", "create", "start", "inspect"]);
  const request = calls.find((call) => call.kind === "create")?.value as { readonly role: string; readonly imageId: string; readonly networks: readonly unknown[] };
  expect(request).toMatchObject({ role: "control", imageId });
  expect(request.networks).toHaveLength(2);
});

test("removes a mismatched control container without deleting the native home", async () => {
  const calls: string[] = [];
  const policy = await buildPolicy();
  const docker = new class extends DockerEngineClient {
    constructor() { super("/fixture.sock"); }
    override ensureImage(): Promise<void> { calls.push("ensure"); return Promise.resolve(); }
    override inspectImage(): Promise<DockerImageInspection> { calls.push("image"); return Promise.resolve(image); }
    override createCodexSplitContainer(): Promise<string> { calls.push("create"); return Promise.resolve("control-id"); }
    override startContainer(): Promise<void> { calls.push("start"); return Promise.resolve(); }
    override inspectContainer(): Promise<DockerContainerInspection> {
      calls.push("inspect");
      return Promise.resolve({ ...dockerImageInspection(policy), Config: {
        ...dockerImageInspection(policy).Config, WorkingDir: "/wrong"
      } });
    }
    override removeContainer(id: string): Promise<void> { calls.push(`remove:${id}`); return Promise.resolve(); }
  }();
  await expect(createCodexControlSidecar({ docker, policy, name: "codex-control" }))
    .rejects.toThrow("codex-control-start-failed");
  expect(calls).toEqual(["ensure", "image", "create", "start", "inspect", "remove:control-id"]);
});

test("retains a bounded stage cause for every control-sidecar startup boundary", async () => {
  const policy = await buildPolicy();
  const cases = [
    { stage: "codex-control-image-resolution", failure: "ensure-image-failed" },
    { stage: "codex-control-image-inspection", failure: "inspect-image-failed" },
    { stage: "codex-control-artifact-compatibility", failure: "codex-artifact-image-architecture" },
    { stage: "codex-control-container-create", failure: "create-container-failed" },
    { stage: "codex-control-container-start", failure: "start-container-failed" },
    { stage: "codex-control-container-inspection", failure: "inspect-container-failed" },
    { stage: "codex-control-inspection-policy", failure: "codex-control-inspection-policy" }
  ] as const;

  for (const currentCase of cases) {
    const docker = new class extends DockerEngineClient {
      constructor() { super("/fixture.sock"); }
      override ensureImage(): Promise<void> {
        if (currentCase.stage === "codex-control-image-resolution") throw new Error(currentCase.failure);
        return Promise.resolve();
      }
      override inspectImage(): Promise<DockerImageInspection> {
        if (currentCase.stage === "codex-control-image-inspection") throw new Error(currentCase.failure);
        if (currentCase.stage === "codex-control-artifact-compatibility") return Promise.resolve({ ...image, Architecture: "arm64" });
        return Promise.resolve(image);
      }
      override createCodexSplitContainer(): Promise<string> {
        if (currentCase.stage === "codex-control-container-create") throw new Error(currentCase.failure);
        return Promise.resolve("control-id");
      }
      override startContainer(): Promise<void> {
        if (currentCase.stage === "codex-control-container-start") throw new Error(currentCase.failure);
        return Promise.resolve();
      }
      override inspectContainer(): Promise<DockerContainerInspection> {
        if (currentCase.stage === "codex-control-container-inspection") throw new Error(currentCase.failure);
        if (currentCase.stage === "codex-control-inspection-policy") {
          return Promise.resolve({ ...dockerImageInspection(policy), Config: {
            ...dockerImageInspection(policy).Config, WorkingDir: "/wrong"
          } });
        }
        return Promise.resolve(dockerImageInspection(policy));
      }
      override removeContainer(): Promise<void> { return Promise.resolve(); }
    }();

    const error = await createCodexControlSidecar({ docker, policy, name: "codex-control" }).catch((caught: unknown) => caught);
    expect(causeMessages(error)).toEqual(["codex-control-start-failed", currentCase.stage, currentCase.failure]);
  }
});
