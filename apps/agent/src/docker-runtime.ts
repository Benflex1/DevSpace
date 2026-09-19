import { lstat } from "node:fs/promises";
import http from "node:http";
import type { Duplex } from "node:stream";
import path from "node:path";
import * as z from "zod";
import { runtimePlanV1Schema, type RuntimePlanV1 } from "@devspace/project-options";

const MAX_JSON_BYTES = 2 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;

export interface RuntimePolicy {
  readonly cpuMillicores: number;
  readonly memoryBytes: number;
  readonly pidLimit: number;
  readonly stabilizationDurationMs: number;
  readonly stabilizationIntervalMs: number;
  readonly stabilizationTimeoutMs: number;
}

function boundedInteger(value: string | undefined, fallback: number, minimum: number, maximum: number, name: string): number {
  if (value === undefined) return fallback;
  if (!/^[1-9][0-9]*$/u.test(value)) throw new Error(`${name} must be a positive base-10 integer.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} is outside the safe deployment range.`);
  }
  return parsed;
}

export function readRuntimePolicy(environment: NodeJS.ProcessEnv = process.env): RuntimePolicy {
  const policy = {
    cpuMillicores: boundedInteger(environment.DEVSPACE_RUNTIME_MAX_CPU_MILLICORES, 2_000, 100, 64_000, "DEVSPACE_RUNTIME_MAX_CPU_MILLICORES"),
    memoryBytes: boundedInteger(environment.DEVSPACE_RUNTIME_MAX_MEMORY_BYTES, 4_294_967_296, 64 * 1024 * 1024, 1_099_511_627_776, "DEVSPACE_RUNTIME_MAX_MEMORY_BYTES"),
    pidLimit: boundedInteger(environment.DEVSPACE_RUNTIME_MAX_PIDS, 512, 16, 32_768, "DEVSPACE_RUNTIME_MAX_PIDS"),
    stabilizationDurationMs: boundedInteger(environment.DEVSPACE_RUNTIME_STABILIZATION_DURATION_MS, 2_000, 100, 60_000,
      "DEVSPACE_RUNTIME_STABILIZATION_DURATION_MS"),
    stabilizationIntervalMs: boundedInteger(environment.DEVSPACE_RUNTIME_STABILIZATION_INTERVAL_MS, 100, 10, 5_000,
      "DEVSPACE_RUNTIME_STABILIZATION_INTERVAL_MS"),
    stabilizationTimeoutMs: boundedInteger(environment.DEVSPACE_RUNTIME_STABILIZATION_TIMEOUT_MS, 10_000, 500, 120_000,
      "DEVSPACE_RUNTIME_STABILIZATION_TIMEOUT_MS")
  };
  if (policy.stabilizationIntervalMs > policy.stabilizationDurationMs
    || policy.stabilizationDurationMs > policy.stabilizationTimeoutMs) {
    throw new Error("Runtime stabilization interval, duration, and timeout are inconsistent.");
  }
  return policy;
}

export function defaultRootlessDockerSocketPath(uid = process.getuid?.()): string {
  if (uid === undefined || !Number.isSafeInteger(uid) || uid < 1) return "/run/user/devspace/docker.sock";
  return `/run/user/${uid}/docker.sock`;
}

export class DockerEngineError extends Error {
  constructor(readonly statusCode: number, readonly responseBody: string) {
    super(`Docker Engine request failed with status ${statusCode}.`);
    this.name = "DockerEngineError";
  }
}

export class DockerEngineTransportError extends Error {
  constructor(readonly cause: unknown) {
    super("Docker Engine transport request failed.");
    this.name = "DockerEngineTransportError";
  }
}

export interface DockerContainerInspection {
  Id: string;
  Name: string;
  Image?: string;
  Config: { Labels: Record<string, string>; Image?: string; WorkingDir: string; User?: string; Entrypoint?: readonly string[] | null; Cmd?: readonly string[] | null };
  State: { Running: boolean; Status: string };
  HostConfig: { Privileged: boolean; PublishAllPorts: boolean; PidMode: string;
    IpcMode: string; UTSMode: string; UsernsMode: string; CgroupnsMode: string;
    NetworkMode: string; PortBindings: Record<string, Array<{ HostIp?: string | undefined; HostPort: string }> | null> | null;
    Devices: unknown[] | null; NanoCpus: number; Memory: number; PidsLimit: number | null;
    CapAdd: string[] | null; CapDrop: string[] | null; SecurityOpt: string[] | null;
    AutoRemove: boolean; ReadonlyRootfs: boolean; RestartPolicy: { Name: string; MaximumRetryCount: number };
    Binds?: readonly string[] | null; Mounts?: readonly unknown[] | null; Tmpfs?: Readonly<Record<string, string>> | null;
    MemorySwap?: number };
  NetworkSettings: {
    Networks: Record<string, { NetworkID: string }> | null;
  };
  Mounts: Array<{ Type: string; Source: string; Destination: string; RW: boolean; Propagation: string }>;
}
export interface DockerImageInspection {
  readonly Id: string;
  readonly Os: string;
  readonly Architecture: string;
  readonly Config: {
    readonly Entrypoint?: readonly string[] | null;
    readonly Cmd?: readonly string[] | null;
  };
}
export interface DockerProbeContainerInput {
  readonly imageId: string;
  /** A stable configured reference used only to ask the engine to create from the verified image. */
  readonly imageReference?: string;
  readonly user: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly environment: Readonly<Record<string, string>>;
  readonly cpuMillicores: number;
  readonly memoryBytes: number;
  readonly pidLimit: number;
}

export interface DockerCodexBootstrapContainerInput {
  readonly imageId: string;
  /** Agent-private staged Codex artifact closure; never a workspace path. */
  readonly artifactRoot: string;
  /** Agent-private empty temporary CODEX_HOME for one authentication attempt. */
  readonly codexHomePath: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly cpuMillicores: number;
  readonly memoryBytes: number;
  readonly pidLimit: number;
}

export function buildCodexBootstrapContainerInput(input: DockerCodexBootstrapContainerInput) {
  if (!/^sha256:[0-9a-f]{32,}$/u.test(input.imageId)
    || input.artifactRoot.length === 0 || input.codexHomePath.length === 0
    || input.artifactRoot.includes("\0") || input.codexHomePath.includes("\0")) {
    throw new Error("codex-bootstrap-container-input-invalid");
  }
  return {
    Image: input.imageId,
    Entrypoint: ["/bin/sh", "-c"],
    Cmd: ["exec sleep 2147483647"],
    WorkingDir: "/",
    User: "",
    Env: ["CODEX_HOME=/opt/codex-home", "HOME=/opt/codex-home", "TMPDIR=/tmp"],
    Labels: { ...input.labels },
    ExposedPorts: {},
    HostConfig: {
      Binds: [],
      Mounts: [
        { Type: "bind", Source: path.resolve(input.artifactRoot), Target: "/opt/codex", ReadOnly: true,
          BindOptions: { Propagation: "rprivate" } },
        { Type: "bind", Source: path.resolve(input.codexHomePath), Target: "/opt/codex-home", ReadOnly: false,
          BindOptions: { Propagation: "rprivate" } }
      ],
      Tmpfs: { "/tmp": "rw,nosuid,nodev,noexec,size=64m" },
      NetworkMode: "bridge", PortBindings: {}, PublishAllPorts: false,
      Privileged: false, PidMode: "", IpcMode: "private", UTSMode: "", UsernsMode: "", CgroupnsMode: "private",
      AutoRemove: false, ReadonlyRootfs: true, RestartPolicy: { Name: "no", MaximumRetryCount: 0 },
      CapAdd: [], CapDrop: ["ALL"], Devices: [], SecurityOpt: ["no-new-privileges:true"],
      NanoCpus: input.cpuMillicores * 1_000_000, Memory: input.memoryBytes, MemorySwap: input.memoryBytes,
      PidsLimit: input.pidLimit
    }
  } as const;
}
export const DOCKER_LOOPBACK_HOST = "127.0.0.1" as const;
export interface DockerPortBinding { readonly HostIp: string; readonly HostPort: string }
export type DockerPortBindings = Readonly<Record<string, readonly DockerPortBinding[]>>;

export interface DockerListedContainer {
  readonly Id: string;
  readonly Names: readonly string[];
  readonly Labels: Record<string, string>;
  readonly State: string;
  readonly Status: string;
}

const portKeySchema = z.string().regex(/^[1-9][0-9]{0,4}\/tcp$/u);
const hostPortSchema = z.string().regex(/^[1-9][0-9]{0,4}$/u).refine((value) => {
  const port = Number(value);
  return Number.isSafeInteger(port) && port >= 1 && port <= 65535;
}, "Host port is outside the valid range.");
const dockerPortBindingSchema = z.strictObject({ HostIp: z.literal(DOCKER_LOOPBACK_HOST), HostPort: hostPortSchema });

/**
 * Validates the only host publication DevSpace permits. This is deliberately
 * stricter than Docker's API: IPv6 loopback, wildcard addresses, host mode,
 * and dynamic host-port allocation are not part of the preview policy.
 */
export function validateDockerPortBindings(
  input: unknown,
  declaredContainerPorts?: readonly number[]
): DockerPortBindings {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("preview-port-bindings-must-be-an-object");
  }
  const declared = declaredContainerPorts === undefined ? null : new Set(declaredContainerPorts);
  const result: Record<string, readonly DockerPortBinding[]> = {};
  for (const [key, value] of Object.entries(input)) {
    if (!portKeySchema.safeParse(key).success) throw new Error("preview-port-key-invalid");
    const containerPort = Number(key.slice(0, -4));
    if (declared !== null && !declared.has(containerPort)) throw new Error("preview-port-not-declared");
    if (!Array.isArray(value) || value.length < 1) throw new Error("preview-port-binding-count-invalid");
    const bindings = value.map((candidate) => dockerPortBindingSchema.parse(candidate));
    const hostPorts = new Set(bindings.map((binding) => binding.HostPort));
    if (hostPorts.size !== bindings.length) throw new Error("preview-host-port-duplicate");
    result[key] = bindings.map((binding) => ({ HostIp: binding.HostIp, HostPort: binding.HostPort }));
  }
  return result;
}

export function dockerPortBindingsEqual(left: unknown, right: DockerPortBindings): boolean {
  try {
    const normalizedLeft = validateDockerPortBindings(left);
    const normalize = (bindings: DockerPortBindings) => Object.entries(bindings)
      .map(([key, values]) => [key, [...values].sort((a, b) => a.HostPort.localeCompare(b.HostPort))] as const)
      .sort(([a], [b]) => a.localeCompare(b));
    const leftEntries = normalize(normalizedLeft);
    const rightEntries = normalize(right);
    return JSON.stringify(leftEntries) === JSON.stringify(rightEntries);
  } catch {
    return false;
  }
}
export interface DockerNetworkInspection {
  readonly Id: string;
  readonly Name: string;
  readonly Labels: Record<string, string>;
}
export interface DockerExecInspection {
  readonly ID: string;
  readonly Running: boolean;
  readonly ExitCode: number | null;
  readonly ContainerID: string;
}

const dockerContainerInspectionSchema = z.object({
  Id: z.string().min(1), Name: z.string().min(1), Image: z.string().min(1).optional(),
  Config: z.object({ Labels: z.record(z.string(), z.string()), Image: z.string().min(1).optional(), WorkingDir: z.string(), User: z.string().optional(),
    Entrypoint: z.array(z.string()).nullable().optional(), Cmd: z.array(z.string()).nullable().optional() }),
  State: z.object({ Running: z.boolean(), Status: z.string() }),
  HostConfig: z.object({
    Privileged: z.boolean(), PublishAllPorts: z.boolean(), PidMode: z.string(), IpcMode: z.string(), UTSMode: z.string(),
    UsernsMode: z.string(), CgroupnsMode: z.string(), NetworkMode: z.string(),
    PortBindings: z.record(z.string(), z.array(z.strictObject({ HostIp: z.string().optional(), HostPort: z.string() })).nullable()).nullable(), Devices: z.array(z.unknown()).nullable(),
    NanoCpus: z.number().int(), Memory: z.number().int(), PidsLimit: z.number().int().nullable(),
    CapAdd: z.array(z.string()).nullable(), CapDrop: z.array(z.string()).nullable(), SecurityOpt: z.array(z.string()).nullable(),
    AutoRemove: z.boolean(), ReadonlyRootfs: z.boolean(),
    RestartPolicy: z.object({ Name: z.string(), MaximumRetryCount: z.number().int() }),
    Binds: z.array(z.string()).nullable().optional(), Mounts: z.array(z.unknown()).nullable().optional(),
    Tmpfs: z.record(z.string(), z.string()).nullable().optional(), MemorySwap: z.number().int().optional()
  }),
  NetworkSettings: z.object({ Networks: z.record(z.string(), z.object({ NetworkID: z.string() })).nullable() }),
  Mounts: z.array(z.object({ Type: z.string(), Source: z.string(), Destination: z.string(), RW: z.boolean(), Propagation: z.string() }))
});
const dockerImageInspectionSchema = z.object({
  Id: z.string().min(1), Os: z.string().min(1), Architecture: z.string().min(1),
  Config: z.object({ Entrypoint: z.array(z.string()).nullable().optional(), Cmd: z.array(z.string()).nullable().optional() })
});
const dockerNetworkInspectionSchema = z.object({
  Id: z.string().min(1), Name: z.string().min(1), Labels: z.record(z.string(), z.string())
});
const dockerExecInspectionSchema = z.object({
  ID: z.string().min(1), Running: z.boolean(), ExitCode: z.number().int().nullable(),
  ContainerID: z.string().min(1)
});
const dockerListedContainerSchema = z.object({
  Id: z.string().min(1), Names: z.array(z.string()), Labels: z.record(z.string(), z.string()),
  State: z.string(), Status: z.string()
});

export class DockerEngineClient {
  constructor(readonly socketPath: string) {}

  private async request(method: string, requestPath: string, body?: unknown, accepted = [200, 201, 204]): Promise<Buffer> {
    const encoded = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    try {
      return await new Promise((resolve, reject) => {
        const request = http.request({
          socketPath: this.socketPath, method, path: requestPath,
          headers: encoded === undefined ? {} : {
            "content-type": "application/json", "content-length": String(encoded.length)
          }
        }, (response) => {
          const chunks: Buffer[] = [];
          let bytes = 0;
          response.on("data", (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > MAX_JSON_BYTES) request.destroy(new Error("docker-engine-response-too-large"));
            else chunks.push(Buffer.from(chunk));
          });
          response.on("end", () => {
            const result = Buffer.concat(chunks);
            if (accepted.includes(response.statusCode ?? 0)) resolve(result);
            else reject(new DockerEngineError(response.statusCode ?? 0, result.toString("utf8").slice(0, 512)));
          });
        });
        request.setTimeout(REQUEST_TIMEOUT_MS, () => request.destroy(new Error("docker-engine-timeout")));
        request.on("error", reject);
        if (encoded !== undefined) request.write(encoded);
        request.end();
      });
    } catch (error) {
      if (error instanceof DockerEngineError) throw error;
      throw new DockerEngineTransportError(error);
    }
  }

  private async json<T>(method: string, requestPath: string, body?: unknown, accepted?: number[]): Promise<T> {
    return JSON.parse((await this.request(method, requestPath, body, accepted)).toString("utf8")) as T;
  }

  async assertRootlessAvailable(): Promise<void> {
    const before = await lstat(this.socketPath, { bigint: true });
    if (before.isSymbolicLink() || !before.isSocket()) throw new Error("docker-socket-not-direct-unix-socket");
    await this.request("GET", "/_ping");
    const info = await this.json<{ SecurityOptions?: unknown }>("GET", "/info");
    const after = await lstat(this.socketPath, { bigint: true });
    if (after.isSymbolicLink() || !after.isSocket() || before.dev !== after.dev || before.ino !== after.ino) {
      throw new Error("docker-socket-replaced-during-verification");
    }
    if (!Array.isArray(info.SecurityOptions) || !info.SecurityOptions.some((value) =>
      typeof value === "string" && /(?:^|[=,:])rootless(?:$|[=,:])/iu.test(value))) {
      throw new Error("docker-daemon-not-rootless");
    }
  }

  async ensureImage(imageReference: string): Promise<void> {
    try { await this.request("GET", `/images/${encodeURIComponent(imageReference)}/json`); }
    catch (error) {
      if (!(error instanceof DockerEngineError) || error.statusCode !== 404) throw error;
      await this.request("POST", `/images/create?fromImage=${encodeURIComponent(imageReference)}`);
    }
  }

  async createNetwork(name: string, labels: Record<string, string>): Promise<string> {
    const response = await this.json<{ Id: string }>("POST", "/networks/create", {
      Name: name, CheckDuplicate: true, Driver: "bridge", Internal: false, Attachable: false,
      Ingress: false, EnableIPv6: false, Options: {}, Labels: labels
    });
    if (typeof response.Id !== "string" || response.Id.length < 1) throw new Error("docker-network-id-missing");
    return response.Id;
  }

  async inspectNetwork(id: string): Promise<DockerNetworkInspection> {
    return dockerNetworkInspectionSchema.parse(await this.json("GET", `/networks/${encodeURIComponent(id)}`));
  }

  async listContainers(): Promise<readonly DockerListedContainer[]> {
    return z.array(dockerListedContainerSchema).parse(
      await this.json("GET", "/containers/json?all=1")
    );
  }

  async createContainer(name: string, input: {
    imageReference: string; worktreePath: string; harnessSlotPath: string; user: string | null; environment: Record<string, string>;
    networkName: string; labels: Record<string, string>; cpuMillicores: number; memoryBytes: number; pidLimit: number;
    portBindings?: DockerPortBindings; declaredContainerPorts?: readonly number[];
  }): Promise<string> {
    if (input.networkName === "host" || input.networkName === "none" || input.networkName === "container"
      || input.networkName.startsWith("container:")) {
      throw new Error("preview-host-network-is-forbidden");
    }
    const portBindings = validateDockerPortBindings(input.portBindings ?? {}, input.declaredContainerPorts);
    const response = await this.json<{ Id: string }>("POST", `/containers/create?name=${encodeURIComponent(name)}`, {
      Image: input.imageReference,
      Cmd: ["sh", "-c", "trap 'exit 0' TERM INT; while :; do sleep 2147483647 & wait $!; done"],
      WorkingDir: "/workspace", User: input.user ?? "",
      Env: Object.entries(input.environment).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .map(([key, value]) => `${key}=${value}`),
      Labels: input.labels, ExposedPorts: Object.fromEntries(Object.keys(portBindings).map((key) => [key, {}])),
      HostConfig: {
        Binds: [], Mounts: [
          { Type: "bind", Source: path.resolve(input.worktreePath), Target: "/workspace", ReadOnly: false,
            BindOptions: { Propagation: "rprivate" } },
          { Type: "bind", Source: path.resolve(input.harnessSlotPath), Target: "/opt/devspace/harness-home", ReadOnly: false,
            BindOptions: { Propagation: "rprivate" } }
        ],
        NetworkMode: input.networkName, PortBindings: portBindings, PublishAllPorts: false,
        Privileged: false, PidMode: "", IpcMode: "private", UTSMode: "", UsernsMode: "", CgroupnsMode: "private",
        AutoRemove: false, ReadonlyRootfs: false, RestartPolicy: { Name: "no", MaximumRetryCount: 0 },
        CapAdd: [], CapDrop: [], Devices: [], SecurityOpt: ["no-new-privileges:true"],
        NanoCpus: input.cpuMillicores * 1_000_000, Memory: input.memoryBytes, PidsLimit: input.pidLimit
      },
      NetworkingConfig: { EndpointsConfig: { [input.networkName]: {} } }
    });
    if (typeof response.Id !== "string" || response.Id.length < 1) throw new Error("docker-container-id-missing");
    return response.Id;
  }

  async inspectContainer(id: string): Promise<DockerContainerInspection> {
    return dockerContainerInspectionSchema.parse(await this.json("GET", `/containers/${encodeURIComponent(id)}/json`)) as DockerContainerInspection;
  }

  async inspectImage(id: string): Promise<DockerImageInspection> {
    return dockerImageInspectionSchema.parse(await this.json("GET", `/images/${encodeURIComponent(id)}/json`)) as DockerImageInspection;
  }

  async startContainer(id: string): Promise<void> {
    await this.request("POST", `/containers/${encodeURIComponent(id)}/start`, undefined, [204, 304]);
  }

  async stopContainer(id: string): Promise<void> {
    await this.request("POST", `/containers/${encodeURIComponent(id)}/stop?t=10`, undefined, [204, 304]);
  }

  async removeContainer(id: string): Promise<void> {
    await this.request("DELETE", `/containers/${encodeURIComponent(id)}?force=1`, undefined, [204]);
  }

  async createProbeContainer(name: string, input: DockerProbeContainerInput): Promise<string> {
    const imageReference = input.imageReference ?? input.imageId;
    if (input.imageId.length === 0 || imageReference.length === 0 || imageReference.includes("\0") || input.user.includes("\0")) {
      throw new Error("probe-image-or-user-invalid");
    }
    const response = await this.json<{ Id: string }>("POST", `/containers/create?name=${encodeURIComponent(name)}`, {
      Image: imageReference,
      Entrypoint: ["/bin/sh", "-c"],
      Cmd: ["exec sleep 2147483647"],
      WorkingDir: "/",
      User: input.user,
      Env: Object.entries(input.environment).sort(([left], [right]) => left.localeCompare(right))
        .map(([key, value]) => `${key}=${value}`),
      Labels: { ...input.labels },
      ExposedPorts: {},
      HostConfig: {
        Binds: [], Mounts: [], Tmpfs: {
          "/opt/devspace-codex-probe": "rw,nosuid,nodev,exec,size=1g",
          "/tmp/devspace-codex-home": "rw,nosuid,nodev,noexec,size=16m",
          "/tmp/devspace-codex-state": "rw,nosuid,nodev,noexec,size=16m"
        },
        NetworkMode: "none", PortBindings: {}, PublishAllPorts: false,
        Privileged: false, PidMode: "", IpcMode: "private", UTSMode: "", UsernsMode: "", CgroupnsMode: "private",
        AutoRemove: false, ReadonlyRootfs: true, RestartPolicy: { Name: "no", MaximumRetryCount: 0 },
        CapAdd: [], CapDrop: ["ALL"], Devices: [], SecurityOpt: ["no-new-privileges:true"],
        NanoCpus: input.cpuMillicores * 1_000_000, Memory: input.memoryBytes, MemorySwap: input.memoryBytes,
        PidsLimit: input.pidLimit
      }
    });
    if (typeof response.Id !== "string" || response.Id.length < 1) throw new Error("docker-probe-container-id-missing");
    return response.Id;
  }

  async createCodexBootstrapContainer(name: string, input: DockerCodexBootstrapContainerInput): Promise<string> {
    const response = await this.json<{ Id: string }>("POST", `/containers/create?name=${encodeURIComponent(name)}`,
      buildCodexBootstrapContainerInput(input));
    if (typeof response.Id !== "string" || response.Id.length < 1) throw new Error("codex-bootstrap-container-id-missing");
    return response.Id;
  }

  async createExec(containerId: string, input: {
    readonly command: readonly string[];
    readonly workingDirectory: string;
    readonly environment: Readonly<Record<string, string>>;
    readonly attachStdin: boolean;
    readonly tty: boolean;
  }): Promise<string> {
    const response = await this.json<{ Id: string }>("POST", `/containers/${encodeURIComponent(containerId)}/exec`, {
      AttachStdin: input.attachStdin, AttachStdout: true, AttachStderr: true,
      DetachKeys: "", Tty: input.tty, Cmd: [...input.command], WorkingDir: input.workingDirectory,
      Env: Object.entries(input.environment).sort(([left], [right]) => left.localeCompare(right))
        .map(([name, value]) => `${name}=${value}`)
    });
    if (typeof response.Id !== "string" || response.Id.length < 1) throw new Error("docker-exec-id-missing");
    return response.Id;
  }

  async startExecAttached(execId: string, tty: boolean): Promise<Duplex> {
    const encoded = Buffer.from(JSON.stringify({ Detach: false, Tty: tty }));
    return await new Promise((resolve, reject) => {
      const request = http.request({
        socketPath: this.socketPath, method: "POST", path: `/exec/${encodeURIComponent(execId)}/start`,
        headers: {
          "content-type": "application/json", "content-length": String(encoded.length),
          connection: "Upgrade", upgrade: "tcp"
        }
      });
      request.setTimeout(REQUEST_TIMEOUT_MS, () => request.destroy(new Error("docker-engine-timeout")));
      request.once("upgrade", (_response, socket, head) => {
        request.setTimeout(0);
        if (head.length > 0) socket.unshift(head);
        resolve(socket);
      });
      request.once("response", (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
        response.once("end", () => reject(new DockerEngineError(response.statusCode ?? 0,
          Buffer.concat(chunks).toString("utf8").slice(0, 512))));
      });
      request.once("error", reject);
      request.end(encoded);
    });
  }

  async resizeExec(execId: string, columns: number, rows: number): Promise<void> {
    await this.request("POST", `/exec/${encodeURIComponent(execId)}/resize?h=${rows}&w=${columns}`, undefined, [200, 201]);
  }

  async inspectExec(execId: string): Promise<DockerExecInspection> {
    return dockerExecInspectionSchema.parse(await this.json("GET", `/exec/${encodeURIComponent(execId)}/json`));
  }

}

export interface EffectiveRuntimeResources { cpuMillicores: number; memoryBytes: number; pidLimit: number }
export function effectiveRuntimeResources(planInput: unknown, policy: RuntimePolicy): EffectiveRuntimeResources {
  const plan = runtimePlanV1Schema.parse(planInput);
  const requested = plan.developmentContainer.resources;
  if ((requested.cpuMillicores ?? policy.cpuMillicores) > policy.cpuMillicores
    || (requested.memoryBytes ?? policy.memoryBytes) > policy.memoryBytes
    || (requested.pidLimit ?? policy.pidLimit) > policy.pidLimit) {
    throw new Error("runtime-plan-exceeds-administrator-policy");
  }
  return {
    cpuMillicores: requested.cpuMillicores ?? policy.cpuMillicores,
    memoryBytes: requested.memoryBytes ?? policy.memoryBytes,
    pidLimit: requested.pidLimit ?? policy.pidLimit
  };
}

export type { RuntimePlanV1 };
