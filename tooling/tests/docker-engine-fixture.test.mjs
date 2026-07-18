import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
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
