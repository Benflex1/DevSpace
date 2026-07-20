import { mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { DockerEngineClient, defaultRootlessDockerSocketPath, effectiveRuntimeResources, readRuntimePolicy } from "./docker-runtime.js";

const directories: string[] = [];
const servers: http.Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => await new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(directories.splice(0).map(async (directory) => await rm(directory, { recursive: true, force: true })));
});

async function engineSocket(securityOptions: string[]): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "devspace-docker-status-")); directories.push(directory);
  const socket = path.join(directory, "engine.sock");
  const server = http.createServer((request, response) => {
    if (request.url === "/_ping") response.writeHead(200).end("OK");
    else if (request.url === "/info") response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ SecurityOptions: securityOptions }));
    else response.writeHead(404).end();
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socket, resolve); });
  return socket;
}

async function recordingEngineSocket(): Promise<{ socket: string; bodies: unknown[] }> {
  const directory = await mkdtemp(path.join(tmpdir(), "devspace-docker-create-")); directories.push(directory);
  const socket = path.join(directory, "engine.sock");
  const bodies: unknown[] = [];
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      if (request.url?.startsWith("/containers/create") === true) bodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      if (request.url?.startsWith("/containers/create") === true) {
        response.writeHead(201, { "content-type": "application/json" }).end(JSON.stringify({ Id: "container-1" }));
      } else response.writeHead(404).end();
    });
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socket, resolve); });
  return { socket, bodies };
}

describe("dedicated rootless Docker boundary", () => {
  test("rejects a missing socket and a regular file path", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "devspace-docker-invalid-")); directories.push(directory);
    await expect(new DockerEngineClient(path.join(directory, "missing.sock")).assertRootlessAvailable()).rejects.toBeDefined();
    const file = path.join(directory, "ordinary-file"); await writeFile(file, "not a socket");
    await expect(new DockerEngineClient(file).assertRootlessAvailable()).rejects.toThrow("docker-socket-not-direct-unix-socket");
  });

  test("rejects rootful daemon information and accepts explicit rootless security information", async () => {
    await expect(new DockerEngineClient(await engineSocket(["name=seccomp,profile=default"])).assertRootlessAvailable())
      .rejects.toThrow("docker-daemon-not-rootless");
    await expect(new DockerEngineClient(await engineSocket(["name=seccomp,profile=default", "name=rootless"])).assertRootlessAvailable())
      .resolves.toBeUndefined();
  });

  test("never defaults to the host daemon and strictly bounds deployment policy", () => {
    expect(defaultRootlessDockerSocketPath(1000)).toBe("/run/user/1000/docker.sock");
    expect(defaultRootlessDockerSocketPath(1000)).not.toBe("/var/run/docker.sock");
    const policy = readRuntimePolicy({});
    expect(effectiveRuntimeResources({ format: "devspace.runtime-plan/v1", developmentContainer: {
      source: { kind: "image", imageReference: "node:24" }, containerUser: null, workingDirectory: "/workspace",
      environment: {}, ports: [], resources: { cpuMillicores: null, memoryBytes: null, pidLimit: null }
    }, services: [], namedVolumes: [], setupSteps: [], passwordlessSudo: false }, policy)).toEqual({
      cpuMillicores: policy.cpuMillicores, memoryBytes: policy.memoryBytes, pidLimit: policy.pidLimit
    });
    expect(() => readRuntimePolicy({ DEVSPACE_RUNTIME_MAX_PIDS: "unbounded" })).toThrow();
    expect(() => readRuntimePolicy({ DEVSPACE_RUNTIME_STABILIZATION_INTERVAL_MS: "1000",
      DEVSPACE_RUNTIME_STABILIZATION_DURATION_MS: "500" })).toThrow("inconsistent");
  });

  test("publishes only declared ports on Docker loopback", async () => {
    const fixture = await recordingEngineSocket();
    const engine = new DockerEngineClient(fixture.socket);
    await expect(engine.createContainer("devspace-preview", {
      imageReference: "node:24", worktreePath: "/workspace/project", user: null, environment: {},
      networkName: "devspace-network", labels: {}, cpuMillicores: 100, memoryBytes: 64 * 1024 * 1024, pidLimit: 16,
      declaredContainerPorts: [3000], portBindings: { "3000/tcp": [{ HostIp: "127.0.0.1", HostPort: "40000" }] }
    })).resolves.toBe("container-1");
    expect(fixture.bodies[0]).toMatchObject({
      ExposedPorts: { "3000/tcp": {} },
      HostConfig: { PublishAllPorts: false, PortBindings: { "3000/tcp": [{ HostIp: "127.0.0.1", HostPort: "40000" }] } }
    });
    await expect(engine.createContainer("devspace-public", {
      imageReference: "node:24", worktreePath: "/workspace/project", user: null, environment: {},
      networkName: "devspace-network", labels: {}, cpuMillicores: 100, memoryBytes: 64 * 1024 * 1024, pidLimit: 16,
      declaredContainerPorts: [3000], portBindings: { "3000/tcp": [{ HostIp: "0.0.0.0", HostPort: "40001" }] }
    })).rejects.toThrow();
    await expect(engine.createContainer("devspace-undeclared", {
      imageReference: "node:24", worktreePath: "/workspace/project", user: null, environment: {},
      networkName: "devspace-network", labels: {}, cpuMillicores: 100, memoryBytes: 64 * 1024 * 1024, pidLimit: 16,
      declaredContainerPorts: [3000], portBindings: { "8080/tcp": [{ HostIp: "127.0.0.1", HostPort: "40002" }] }
    })).rejects.toThrow();
    await expect(engine.createContainer("devspace-host", {
      imageReference: "node:24", worktreePath: "/workspace/project", user: null, environment: {},
      networkName: "container:other", labels: {}, cpuMillicores: 100, memoryBytes: 64 * 1024 * 1024, pidLimit: 16
    })).rejects.toThrow("preview-host-network-is-forbidden");
  });
});
