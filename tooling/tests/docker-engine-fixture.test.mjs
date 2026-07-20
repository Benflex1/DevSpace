import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createDockerEngineFixture } from "../docker-engine-fixture.mjs";

async function request(socketPath, method, requestPath, body) {
  const encoded = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  return await new Promise((resolve, reject) => {
    const outgoing = http.request({ socketPath, method, path: requestPath, headers: encoded === undefined ? {} : {
      "content-type": "application/json", "content-length": String(encoded.length)
    } }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => resolve({ status: response.statusCode,
        body: chunks.length === 0 ? null : JSON.parse(Buffer.concat(chunks).toString("utf8")) }));
    });
    outgoing.on("error", reject);
    if (encoded !== undefined) outgoing.write(encoded);
    outgoing.end();
  });
}

async function createPreviewFixture() {
  const root = await mkdtemp(path.join(tmpdir(), "devspace-engine-preview-test-"));
  const workspaceRoot = path.join(root, "workspaces");
  await mkdir(path.join(workspaceRoot, "owned"), { recursive: true });
  const socket = path.join(root, "docker.sock");
  const fixture = await createDockerEngineFixture(socket, workspaceRoot);
  const network = await request(socket, "POST", "/networks/create", {
    Name: "devspace-preview-test-network", Driver: "bridge",
    Labels: { "devspace.managed": "true", "devspace.resource-role": "network" }
  });
  assert.equal(network.status, 201);
  return { root, socket, fixture, workspaceRoot, networkName: "devspace-preview-test-network" };
}

async function createContainer(harness, name, hostPort, containerPort = 3000) {
  const response = await request(harness.socket, "POST", `/containers/create?name=${name}`, {
    Image: "node:24", Cmd: ["sh", "-c", "fixed"], WorkingDir: "/workspace",
    Labels: { "devspace.managed": "true", "devspace.resource-role": "development-container" },
    ExposedPorts: { [`${containerPort}/tcp`]: {} },
    HostConfig: { Privileged: false, PublishAllPorts: false,
      PortBindings: { [`${containerPort}/tcp`]: [{ HostIp: "127.0.0.1", HostPort: String(hostPort) }] },
      PidMode: "", IpcMode: "private", UTSMode: "", UsernsMode: "", CgroupnsMode: "private",
      NetworkMode: harness.networkName, Devices: [], CapAdd: [], CapDrop: [], SecurityOpt: ["no-new-privileges:true"],
      AutoRemove: false, ReadonlyRootfs: false, RestartPolicy: { Name: "no", MaximumRetryCount: 0 },
      NanoCpus: 2_000_000_000, Memory: 1_073_741_824, PidsLimit: 256,
      Mounts: [{ Type: "bind", Source: path.join(harness.workspaceRoot, name), Target: "/workspace", ReadOnly: false,
        BindOptions: { Propagation: "rprivate" } }]
    }
  });
  assert.equal(response.status, 201);
  await request(harness.socket, "POST", `/containers/${response.body.Id}/start`);
  return response.body.Id;
}

async function createTerminalExec(harness, containerId) {
  const created = await request(harness.socket, "POST", `/containers/${containerId}/exec`, {
    Cmd: ["/bin/sh"], WorkingDir: "/workspace", Env: [], AttachStdout: true, AttachStderr: true, Tty: true
  });
  assert.equal(created.status, 201);
  const execId = created.body.Id;
  const socket = net.connect(harness.socket);
  await new Promise((resolve, reject) => {
    let output = "";
    socket.once("error", reject);
    socket.on("data", (chunk) => {
      output += chunk.toString("utf8");
      if (output.includes("/workspace $ ")) { socket.removeAllListeners("error"); resolve(); }
    });
    const body = JSON.stringify({ Detach: false, Tty: true });
    socket.once("connect", () => socket.write(`POST /exec/${execId}/start HTTP/1.1\r\nHost: docker.local\r\nConnection: Upgrade\r\nUpgrade: tcp\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`));
  });
  return { execId, socket };
}

async function httpRequest(port, requestPath = "/") {
  return await new Promise((resolve, reject) => {
    const outgoing = http.request({ host: "127.0.0.1", port, path: requestPath, headers: { connection: "close" } }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
    });
    outgoing.once("error", reject);
    outgoing.end();
  });
}

async function closePreviewFixture(harness) {
  await harness.fixture.close();
  await rm(harness.root, { recursive: true, force: true });
}

test("Docker fixture persists effective create state and supports policy/lifecycle drift", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "devspace-engine-fixture-test-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const workspaceRoot = path.join(root, "workspaces"); await mkdir(path.join(workspaceRoot, "owned"), { recursive: true });
  const socket = path.join(root, "docker.sock");
  const fixture = await createDockerEngineFixture(socket, workspaceRoot);
  context.after(async () => await fixture.close());
  const labels = { "devspace.managed": "true", "devspace.resource-role": "network" };
  const network = await request(socket, "POST", "/networks/create", {
    Name: "devspace-test-network", Driver: "bridge", Labels: labels
  });
  assert.equal(network.status, 201);
  const containerLabels = { "devspace.managed": "true", "devspace.resource-role": "development-container" };
  const created = await request(socket, "POST", "/containers/create?name=devspace-test-development", {
    Image: "node:24", Cmd: ["sh", "-c", "fixed"], WorkingDir: "/workspace", Labels: containerLabels,
    HostConfig: { Privileged: false, PublishAllPorts: false, PortBindings: {}, PidMode: "", IpcMode: "private",
      UTSMode: "", UsernsMode: "", CgroupnsMode: "private",
      NetworkMode: "devspace-test-network", Devices: [], CapAdd: [], CapDrop: [], SecurityOpt: ["no-new-privileges:true"],
      AutoRemove: false, ReadonlyRootfs: false, RestartPolicy: { Name: "no", MaximumRetryCount: 0 },
      NanoCpus: 2_000_000_000, Memory: 1_073_741_824, PidsLimit: 256,
      Mounts: [{ Type: "bind", Source: path.join(workspaceRoot, "owned"), Target: "/workspace", ReadOnly: false,
        BindOptions: { Propagation: "rprivate" } }] }
  });
  assert.equal(created.status, 201);
  const containerId = created.body.Id;
  const inspected = (await request(socket, "GET", `/containers/${containerId}/json`)).body;
  assert.deepEqual(inspected.HostConfig, {
    Privileged: false, PublishAllPorts: false, PidMode: "", IpcMode: "private", UTSMode: "", UsernsMode: "",
    CgroupnsMode: "private", NetworkMode: "devspace-test-network",
    PortBindings: {}, Devices: [], NanoCpus: 2_000_000_000, Memory: 1_073_741_824, PidsLimit: 256,
    CapAdd: [], CapDrop: [], SecurityOpt: ["no-new-privileges:true"], AutoRemove: false, ReadonlyRootfs: false,
    RestartPolicy: { Name: "no", MaximumRetryCount: 0 }
  });
  assert.deepEqual(inspected.NetworkSettings.Networks, {
    "devspace-test-network": { NetworkID: "" }
  });

  await request(socket, "POST", `/containers/${containerId}/start`);
  const materialized = (await request(socket, "GET", `/containers/${containerId}/json`)).body;
  assert.deepEqual(materialized.NetworkSettings.Networks, {
    "devspace-test-network": { NetworkID: network.body.Id }
  });

  fixture.driftContainer(containerId, (container) => {
    container.NetworkSettings.Networks.extra = { NetworkID: "foreign" };
    container.HostConfig.NanoCpus = 1;
    container.HostConfig.Memory = 2;
    container.HostConfig.PidsLimit = 3;
    container.HostConfig.IpcMode = "host";
    container.HostConfig.CapAdd = ["SYS_ADMIN"];
    container.HostConfig.CapDrop = ["NET_RAW"];
    container.HostConfig.SecurityOpt = [];
  });
  const drifted = fixture.snapshot().containers[0];
  assert.deepEqual(Object.keys(drifted.NetworkSettings.Networks).sort(), ["devspace-test-network", "extra"]);
  assert.deepEqual([drifted.HostConfig.NanoCpus, drifted.HostConfig.Memory, drifted.HostConfig.PidsLimit,
    drifted.HostConfig.IpcMode, drifted.HostConfig.CapAdd, drifted.HostConfig.CapDrop, drifted.HostConfig.SecurityOpt],
  [1, 2, 3, "host", ["SYS_ADMIN"], ["NET_RAW"], []]);

  fixture.setContainerLifecycle(containerId, { exitAt: 2 });
  assert.equal((await request(socket, "GET", `/containers/${containerId}/json`)).body.State.Running, true);
  assert.equal((await request(socket, "GET", `/containers/${containerId}/json`)).body.State.Running, false);
});

test("an application listener is owned by the exact bound container and exec", async () => {
  const harness = await createPreviewFixture();
  try {
    const containerA = await createContainer(harness, "container-a", 43101);
    const terminalA = await createTerminalExec(harness, containerA);
    await harness.fixture.startApplicationForExec(terminalA.execId, 3000);
    const snapshot = harness.fixture.snapshot();
    assert.deepEqual(snapshot.appListeners, [{ containerId: containerA, execId: terminalA.execId, containerPort: 3000,
      hostPort: 43101, listening: true }]);
    const response = await httpRequest(43101);
    assert.equal(response.status, 200);
    assert.match(response.body, new RegExp(containerA, "u"));
    terminalA.socket.destroy();
  } finally { await closePreviewFixture(harness); }
});

test("container B cannot answer container A's bound target", async () => {
  const harness = await createPreviewFixture();
  try {
    const containerA = await createContainer(harness, "container-a", 43102);
    const containerB = await createContainer(harness, "container-b", 43103);
    const terminalA = await createTerminalExec(harness, containerA);
    const terminalB = await createTerminalExec(harness, containerB);
    await harness.fixture.startApplicationForExec(terminalA.execId, 3000);
    await harness.fixture.startApplicationForExec(terminalB.execId, 3000);
    const responseA = await httpRequest(43102);
    const responseB = await httpRequest(43103);
    assert.match(responseA.body, new RegExp(containerA, "u"));
    assert.doesNotMatch(responseA.body, new RegExp(containerB, "u"));
    assert.match(responseB.body, new RegExp(containerB, "u"));
    terminalA.socket.destroy(); terminalB.socket.destroy();
  } finally { await closePreviewFixture(harness); }
});

test("an undeclared container port cannot become an application target", async () => {
  const harness = await createPreviewFixture();
  try {
    const container = await createContainer(harness, "container-undeclared", 43104);
    const terminal = await createTerminalExec(harness, container);
    await assert.rejects(harness.fixture.startApplicationForExec(terminal.execId, 4000), /preview-binding-missing/u);
    assert.deepEqual(harness.fixture.snapshot().appListeners, []);
    terminal.socket.destroy();
  } finally { await closePreviewFixture(harness); }
});

test("stopping retains the exact binding but removes the application listener", async () => {
  const harness = await createPreviewFixture();
  try {
    const container = await createContainer(harness, "container-stop", 43105);
    const terminal = await createTerminalExec(harness, container);
    await harness.fixture.startApplicationForExec(terminal.execId, 3000);
    const stopped = await request(harness.socket, "POST", `/containers/${container}/stop`);
    assert.equal(stopped.status, 204);
    assert.deepEqual(harness.fixture.snapshot().appListeners, []);
    const retained = harness.fixture.snapshot().containers.find((candidate) => candidate.Id === container);
    assert.deepEqual(retained?.HostConfig.PortBindings, { "3000/tcp": [{ HostIp: "127.0.0.1", HostPort: "43105" }] });
    await assert.rejects(httpRequest(43105));
    terminal.socket.destroy();
  } finally { await closePreviewFixture(harness); }
});

test("removing a container prevents its old application target from answering", async () => {
  const harness = await createPreviewFixture();
  try {
    const oldContainer = await createContainer(harness, "container-old", 43106);
    const oldTerminal = await createTerminalExec(harness, oldContainer);
    await harness.fixture.startApplicationForExec(oldTerminal.execId, 3000);
    await request(harness.socket, "POST", `/containers/${oldContainer}/stop`);
    assert.equal(await harness.fixture.removeContainer(oldContainer), true);
    await assert.rejects(httpRequest(43106));
    const replacement = await createContainer(harness, "container-replacement", 43106);
    const replacementTerminal = await createTerminalExec(harness, replacement);
    await harness.fixture.startApplicationForExec(replacementTerminal.execId, 3000);
    const response = await httpRequest(43106);
    assert.match(response.body, new RegExp(replacement, "u"));
    assert.doesNotMatch(response.body, new RegExp(oldContainer, "u"));
    oldTerminal.socket.destroy(); replacementTerminal.socket.destroy();
  } finally { await closePreviewFixture(harness); }
});
