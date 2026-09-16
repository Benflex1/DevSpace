import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  assertCodexProjectExecutorInspection,
  buildCodexProjectExecutorPolicy,
  createCodexProjectExecutor
} from "./project-executor.js";
import type { CodexSplitArtifactBinding } from "./artifact.js";
import type { CodexSplitNetworkBinding } from "./network.js";
import { DockerEngineClient, type DockerContainerInspection, type DockerImageInspection } from "../docker-runtime.js";
import type { WorkspaceExecutionContext } from "../managed-workspaces.js";
import { lstatIdentity } from "../private-state.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
});

const ids = {
  projectId: "018f0f00-0000-7000-8000-000000000001",
  workspaceId: "018f0f00-0000-7000-8000-000000000002",
  revisionId: "018f0f00-0000-7000-8000-000000000003"
};
const imageId = `sha256:${"a".repeat(64)}`;

function network(): CodexSplitNetworkBinding {
  return {
    execution: {
      role: "execution", workspaceId: ids.workspaceId, generation: 1, id: "execution-id", name: "execution-network",
      controlAlias: "codex-control", executorAlias: "codex-executor", internal: true, defaultRoute: false, publishedPorts: []
    },
    controlEgress: {
      role: "control-egress", workspaceId: ids.workspaceId, generation: 1, id: "egress-id", name: "egress-network",
      controlAlias: "codex-control", executorAttached: false, internal: false, defaultRoute: true,
      publishedPorts: [], defaultBridgeUsed: false
    }
  };
}

function artifact(): CodexSplitArtifactBinding {
  return {
    staged: {
      artifact: {
        configuredPath: "/srv/codex",
        canonicalSourceRoot: "/srv/codex",
        layout: "standalone-package",
        target: { os: "linux", architecture: "x86_64", abi: "musl" },
        packageVersion: "0.153.4",
        entrypoint: { relativePath: "bin/codex", kind: "file", mode: 0o755, linkTarget: null, byteLength: 1, sha256: "a".repeat(64) },
        entries: [{ relativePath: "codex-resources/bwrap", kind: "file", mode: 0o755, linkTarget: null, byteLength: 1, sha256: "b".repeat(64) }],
        entrypointSha256: "a".repeat(64), closureDigest: "c".repeat(64)
      },
      stagingRoot: "/srv/state/codex-artifacts/staged",
      entrypointPath: "/srv/state/codex-artifacts/staged/bin/codex",
      readbackManifestPath: "/srv/state/codex-artifacts/staged/manifest.json"
    },
    packageVersion: "0.153.4", closureDigest: "c".repeat(64), mountTarget: "/opt/devspace/codex",
    entrypointPath: "/opt/devspace/codex/bin/codex", launcherPath: "/opt/devspace/codex-launcher/codex",
    launcherSourceRoot: "/srv/state/codex-split-launchers/c", launcherSourcePath: "/srv/state/codex-split-launchers/c/codex"
  };
}

function developmentContainer(image: DockerImageInspection): DockerContainerInspection {
  return {
    Id: "development-id", Name: "/development", Image: image.Id,
    Config: {
      Labels: {}, Image: "node:24-bookworm", WorkingDir: "/workspace", User: "",
      Env: image.Config.Env ?? null
    },
    State: { Running: true, Status: "running" },
    HostConfig: {
      Privileged: false, PublishAllPorts: false, PidMode: "", IpcMode: "private", UTSMode: "",
      UsernsMode: "", CgroupnsMode: "private", NetworkMode: "runtime-network", PortBindings: {},
      Devices: [], NanoCpus: 1_000_000_000, Memory: 512 * 1024 * 1024, PidsLimit: 128,
      CapAdd: [], CapDrop: [], SecurityOpt: ["no-new-privileges:true"], AutoRemove: false,
      ReadonlyRootfs: false, RestartPolicy: { Name: "no", MaximumRetryCount: 0 }, Binds: [], Mounts: [],
      Tmpfs: {}, MemorySwap: 512 * 1024 * 1024
    },
    NetworkSettings: { Networks: { "runtime-network": { NetworkID: "runtime-network-id" } } },
    Mounts: [{ Type: "bind", Source: "/fixture/worktree", Destination: "/workspace", RW: true, Propagation: "rprivate" }]
  };
}

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "devspace-project-executor-"));
  roots.push(root);
  const worktreePath = path.join(root, "worktree");
  const repositoryPath = path.join(root, "repository.git");
  const administrationPath = path.join(repositoryPath, "worktrees", "workspace");
  await mkdir(worktreePath, { recursive: true });
  await mkdir(administrationPath, { recursive: true });
  await writeFile(path.join(worktreePath, ".git"), `gitdir: ${administrationPath}\n`);
  const context = {
    ...ids,
    revisionHash: `sha256-jcs-v1:${"1".repeat(64)}`,
    runtimePlanHash: `sha256-jcs-v1:${"2".repeat(64)}`,
    generation: 1,
    ownership: {
      projectId: ids.projectId, workspaceId: ids.workspaceId, revisionId: ids.revisionId,
      revisionHash: `sha256-jcs-v1:${"1".repeat(64)}`, runtimePlanHash: `sha256-jcs-v1:${"2".repeat(64)}`, generation: 1,
      worktreePath, resources: { cpuMillicores: 1000, memoryBytes: 512 * 1024 * 1024, pidLimit: 128 },
      previewBindings: [], network: { id: "runtime-network", name: "runtime-network", labels: {} },
      developmentContainer: { id: "development-id", name: "development", labels: {} }
    },
    options: { schemaVersion: 1, developmentEnvironment: { source: { kind: "image", imageReference: "node:24-bookworm" } } }
  } as unknown as WorkspaceExecutionContext;
  const git = {
    projectId: ids.projectId, workspaceId: ids.workspaceId, worktreePath, repositoryPath, administrationPath,
    worktreeIdentity: (await lstatIdentity(worktreePath))!.identity,
    repositoryIdentity: (await lstatIdentity(repositoryPath))!.identity,
    administrationIdentity: (await lstatIdentity(administrationPath))!.identity
  };
  const image: DockerImageInspection = { Id: imageId, Os: "linux", Architecture: "amd64", Config: { Env: ["PATH=/usr/bin:/bin"] } };
  return { root, context, git, image, container: developmentContainer(image) };
}

function dockerFor(fixtureValue: Awaited<ReturnType<typeof fixture>>, overrides: {
  readonly image?: DockerImageInspection;
  readonly container?: DockerContainerInspection;
} = {}): DockerEngineClient {
  return new class extends DockerEngineClient {
    constructor() { super("/fixture.sock"); }
    override inspectContainer(): Promise<DockerContainerInspection> {
      return Promise.resolve(overrides.container ?? fixtureValue.container);
    }
    override inspectImage(): Promise<DockerImageInspection> {
      return Promise.resolve(overrides.image ?? fixtureValue.image);
    }
  }();
}

function executorInspection(policy: Awaited<ReturnType<typeof buildCodexProjectExecutorPolicy>>): DockerContainerInspection {
  const userPolicy = policy.containerUser as unknown;
  const effectiveUser = typeof userPolicy === "string"
    ? userPolicy
    : (userPolicy as { readonly effectiveUser: string }).effectiveUser;
  return {
    Id: "executor-id", Name: "/codex-executor", Image: policy.imageId,
    Config: {
      Labels: { ...policy.labels }, Image: policy.imageReference, WorkingDir: policy.workingDirectory,
      User: effectiveUser, Env: Object.entries(policy.environment).map(([name, value]) => `${name}=${value}`),
      Entrypoint: ["/bin/sh", "-c"], Cmd: ["exec sleep 2147483647"]
    },
    State: { Running: true, Status: "running" },
    HostConfig: {
      Privileged: false, PublishAllPorts: false, PidMode: "", IpcMode: "private", UTSMode: "",
      UsernsMode: "", CgroupnsMode: "private", NetworkMode: policy.executionNetwork.name, PortBindings: {},
      Devices: [], NanoCpus: policy.resources.cpuMillicores * 1_000_000, Memory: policy.resources.memoryBytes,
      PidsLimit: policy.resources.pidLimit, CapAdd: [], CapDrop: ["ALL"], SecurityOpt: ["no-new-privileges:true"],
      AutoRemove: false, ReadonlyRootfs: false, RestartPolicy: { Name: "no", MaximumRetryCount: 0 },
      Binds: [], Mounts: [], Tmpfs: { ...policy.tmpfs }, MemorySwap: policy.resources.memoryBytes
    },
    NetworkSettings: { Networks: { [policy.executionNetwork.name]: { NetworkID: policy.executionNetwork.id } } },
    Mounts: policy.mounts.map((mount) => ({
      Type: mount.Type, Source: mount.Source, Destination: mount.Target, RW: !mount.ReadOnly,
      Propagation: mount.BindOptions.Propagation
    }))
  };
}

test("builds an exact-image executor policy with only workspace, Git, and trusted artifact mounts", async () => {
  const fixtureValue = await fixture();
  const policy = await buildCodexProjectExecutorPolicy({
    docker: dockerFor(fixtureValue),
    context: fixtureValue.context,
    git: fixtureValue.git,
    network: network(),
    artifact: artifact(),
    imagePort: 4545
  });
  expect(policy.imageId).toBe(imageId);
  expect(policy.imageReference).toBe("node:24-bookworm");
  expect(policy.workingDirectory).toBe("/workspace");
  expect(policy.networkAttachments).toHaveLength(1);
  expect(policy.mounts).toEqual(expect.arrayContaining([
    expect.objectContaining({ Source: fixtureValue.git.worktreePath, Target: "/workspace", ReadOnly: false }),
    expect.objectContaining({ Source: fixtureValue.git.repositoryPath, Target: fixtureValue.git.repositoryPath, ReadOnly: false }),
    expect.objectContaining({ Source: fixtureValue.git.administrationPath, Target: fixtureValue.git.administrationPath, ReadOnly: false }),
    expect.objectContaining({ Target: "/opt/devspace/codex", ReadOnly: true }),
    expect.objectContaining({ Target: "/opt/devspace/codex-launcher", ReadOnly: true })
  ]));
  expect(policy.environment).not.toHaveProperty("CODEX_HOME");
  expect(policy.mounts).not.toEqual(expect.arrayContaining([expect.objectContaining({ Target: "/codex-home" })]));
  expect(policy.controlEgressAttached).toBe(false);
});

test("preserves image-default user semantics and encodes the executor request without a user override", async () => {
  const fixtureValue = await fixture();
  const policy = await buildCodexProjectExecutorPolicy({
    docker: dockerFor(fixtureValue), context: fixtureValue.context, git: fixtureValue.git,
    network: network(), artifact: artifact(), imagePort: 4545
  });
  expect(policy.containerUser).toEqual({ mode: "image-default", configuredUser: null, effectiveUser: "" });

  let requestUser: unknown;
  const docker = new class extends DockerEngineClient {
    constructor() { super("/fixture.sock"); }
    override createCodexSplitContainer(_name: string, input: unknown): Promise<string> {
      requestUser = (input as { readonly user: unknown }).user;
      return Promise.resolve("executor-id");
    }
    override startContainer(): Promise<void> { return Promise.resolve(); }
    override inspectContainer(): Promise<DockerContainerInspection> { return Promise.resolve(executorInspection(policy)); }
    override inspectImage(): Promise<DockerImageInspection> { return Promise.resolve(fixtureValue.image); }
  }();
  await expect(createCodexProjectExecutor({ docker, policy, name: "codex-executor" })).resolves.toBeDefined();
  expect(requestUser).toBeNull();
});

test("preserves explicit user semantics and rejects runtime or executor user mismatches", async () => {
  const fixtureValue = await fixture();
  const explicitContext = {
    ...fixtureValue.context,
    options: {
      ...fixtureValue.context.options,
      developmentEnvironment: { ...fixtureValue.context.options.developmentEnvironment, containerUser: "1000:1000" }
    }
  };
  const explicitContainer = {
    ...fixtureValue.container,
    Config: { ...fixtureValue.container.Config, User: "1000:1000" }
  };
  const explicitPolicy = await buildCodexProjectExecutorPolicy({
    docker: dockerFor(fixtureValue, { container: explicitContainer }), context: explicitContext,
    git: fixtureValue.git, network: network(), artifact: artifact(), imagePort: 4545
  });
  expect(explicitPolicy.containerUser).toEqual({ mode: "explicit", configuredUser: "1000:1000", effectiveUser: "1000:1000" });
  const explicitBinding = {
    policy: explicitPolicy, containerId: "executor-id", containerName: "codex-executor",
    endpointHost: "codex-executor" as const, endpointPort: 4545, controlEgressAttached: false as const
  };
  expect(() => assertCodexProjectExecutorInspection({
    container: executorInspection(explicitPolicy), image: fixtureValue.image, binding: explicitBinding
  })).not.toThrow();

  const defaultPolicy = await buildCodexProjectExecutorPolicy({
    docker: dockerFor(fixtureValue), context: fixtureValue.context, git: fixtureValue.git,
    network: network(), artifact: artifact(), imagePort: 4545
  });
  const defaultBinding = {
    policy: defaultPolicy, containerId: "executor-id", containerName: "codex-executor",
    endpointHost: "codex-executor" as const, endpointPort: 4545, controlEgressAttached: false as const
  };
  expect(() => assertCodexProjectExecutorInspection({
    container: { ...executorInspection(defaultPolicy), Config: { ...executorInspection(defaultPolicy).Config, User: "1000:1000" } },
    image: fixtureValue.image, binding: defaultBinding
  })).toThrow("codex-executor-inspection-policy");
  await expect(buildCodexProjectExecutorPolicy({
    docker: dockerFor(fixtureValue), context: explicitContext, git: fixtureValue.git,
    network: network(), artifact: artifact(), imagePort: 4545
  })).rejects.toThrow("codex-executor-user-runtime");
});

test("does not create an executor when the exact image or workspace identity is not proven", async () => {
  const fixtureValue = await fixture();
  await expect(buildCodexProjectExecutorPolicy({
    docker: dockerFor(fixtureValue, { image: { ...fixtureValue.image, Id: `sha256:${"d".repeat(64)}` } }),
    context: fixtureValue.context, git: fixtureValue.git, network: network(), artifact: artifact(), imagePort: 4545
  })).rejects.toThrow("codex-executor-image");
});

test("rejects project identity drift, forbidden environment, and incompatible artifact images", async () => {
  const fixtureValue = await fixture();
  await expect(buildCodexProjectExecutorPolicy({
    docker: dockerFor(fixtureValue), context: fixtureValue.context,
    git: { ...fixtureValue.git, worktreeIdentity: { device: "999", inode: "999" } },
    network: network(), artifact: artifact(), imagePort: 4545
  })).rejects.toThrow("codex-executor-worktree-identity");

  const forbiddenOptions = {
    ...fixtureValue.context.options,
    developmentEnvironment: {
      ...fixtureValue.context.options.developmentEnvironment,
      environment: { CODEX_HOME: { kind: "literal" as const, value: "/secret" } }
    }
  };
  await expect(buildCodexProjectExecutorPolicy({
    docker: dockerFor(fixtureValue), context: { ...fixtureValue.context, options: forbiddenOptions },
    git: fixtureValue.git, network: network(), artifact: artifact(), imagePort: 4545
  })).rejects.toThrow("codex-executor-credential-environment");

  await expect(buildCodexProjectExecutorPolicy({
    docker: dockerFor(fixtureValue, { image: { ...fixtureValue.image, Architecture: "arm64" } }),
    context: fixtureValue.context, git: fixtureValue.git, network: network(), artifact: artifact(), imagePort: 4545
  })).rejects.toThrow("codex-artifact-image-architecture");
});

test("inspection rejects an extra mount or a control-egress attachment", async () => {
  const fixtureValue = await fixture();
  const policy = await buildCodexProjectExecutorPolicy({
    docker: dockerFor(fixtureValue), context: fixtureValue.context, git: fixtureValue.git,
    network: network(), artifact: artifact(), imagePort: 4545
  });
  const binding = {
    policy, containerId: "executor-id", containerName: "codex-executor",
    endpointHost: "codex-executor" as const, endpointPort: 4545, controlEgressAttached: false as const
  };
  const inspection = executorInspection(policy);
  expect(() => assertCodexProjectExecutorInspection({ container: inspection, image: fixtureValue.image, binding })).not.toThrow();
  expect(() => assertCodexProjectExecutorInspection({
    container: { ...inspection, Mounts: [...inspection.Mounts, {
      Type: "bind", Source: "/managed", Destination: "/managed", RW: true, Propagation: "rprivate"
    }] }, image: fixtureValue.image, binding
  })).toThrow("codex-executor-inspection-policy");
  expect(() => assertCodexProjectExecutorInspection({
    container: {
      ...inspection,
      NetworkSettings: {
        Networks: {
          ...inspection.NetworkSettings.Networks!,
          "egress-network": { NetworkID: "egress-id" }
        }
      }
    }, image: fixtureValue.image, binding
  })).toThrow("codex-executor-inspection-policy");
});

test("uses the dedicated split-container Docker operation", async () => {
  const calls: unknown[] = [];
  const docker = new class extends DockerEngineClient {
    constructor() { super("/fixture.sock"); }
    override createCodexSplitContainer(_name: string, input: never): Promise<string> { calls.push(input); return Promise.resolve("executor-id"); }
    override startContainer(id: string): Promise<void> { calls.push(id); return Promise.resolve(); }
    override inspectContainer(): Promise<DockerContainerInspection> { calls.push("inspect"); return Promise.resolve(executorInspection(policy)); }
    override inspectImage(): Promise<DockerImageInspection> { calls.push("image"); return Promise.resolve(fixtureValue.image); }
  }();
  const fixtureValue = await fixture();
  const policy = await buildCodexProjectExecutorPolicy({
    docker: dockerFor(fixtureValue),
    context: fixtureValue.context, git: fixtureValue.git, network: network(), artifact: artifact(), imagePort: 4545
  });
  await expect(createCodexProjectExecutor({ docker, policy, name: "codex-executor" })).resolves.toMatchObject({
    containerId: "executor-id", endpointHost: "codex-executor", endpointPort: 4545, controlEgressAttached: false
  });
  expect(calls).toHaveLength(4);
});
