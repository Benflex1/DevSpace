import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createPreviewGatewayFixture } from "../preview-gateway-fixture.mjs";

const route = (hostPort, overrides = {}) => ({
  projectId: "project-1", workspaceId: "workspace-1", previewId: "preview-1", revisionId: "revision-1",
  generation: 1, hostname: "web.localhost", approvedBaseId: "local", leaseId: "lease-1",
  hostIp: "127.0.0.1", hostPort, webSocketForwarding: true, ...overrides
});

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") reject(new Error("backend-address-missing"));
      else resolve(address.port);
    });
  });
}

function request(port, host, path = "/") {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const outgoing = http.request({ host: "127.0.0.1", port, path, headers: { host } }, (response) => {
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
    });
    outgoing.once("error", reject);
    outgoing.end();
  });
}

function unixRequest(socketPath, method, requestPath, body) {
  const encoded = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const outgoing = http.request({ socketPath, method, path: requestPath, headers: encoded === undefined ? {} : {
      "content-type": "application/json", "content-length": String(encoded.length)
    }}, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => resolve({ status: response.statusCode,
        body: chunks.length === 0 ? null : JSON.parse(Buffer.concat(chunks).toString("utf8")) }));
    });
    outgoing.once("error", reject);
    if (encoded !== undefined) outgoing.write(encoded);
    outgoing.end();
  });
}

test("deterministic fixture forwards exact-host HTTP streams and rejects other hosts", async () => {
  const backend = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/plain", "transfer-encoding": "chunked" });
    response.write("first-");
    setTimeout(() => response.end("second"), 20);
  });
  const backendPort = await listen(backend);
  const gateway = await createPreviewGatewayFixture();
  try {
    gateway.registerLease({ leaseId: "lease-1", hostPort: backendPort });
    gateway.ensureRoute(route(backendPort));
    assert.deepEqual(await request(gateway.address().port, "web.localhost", "/stream"), { status: 200, body: "first-second" });
    assert.equal((await request(gateway.address().port, "other.localhost", "/stream")).status, 404);
    gateway.removeRoute(route(backendPort));
    assert.equal((await request(gateway.address().port, "web.localhost", "/stream")).status, 404);
  } finally {
    await gateway.close();
    await new Promise((resolve, reject) => backend.close((error) => error === undefined ? resolve() : reject(error)));
  }
});

test("deterministic fixture forwards WebSocket/HMR upgrades only through the exact route", async () => {
  const backend = net.createServer((socket) => {
    let requestText = "";
    socket.on("data", (chunk) => {
      requestText += chunk.toString("utf8");
      if (requestText.includes("\r\n\r\n")) {
        socket.write("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\npong");
      }
    });
  });
  const backendPort = await listen(backend);
  const gateway = await createPreviewGatewayFixture();
  try {
    gateway.registerLease({ leaseId: "lease-1", hostPort: backendPort });
    gateway.ensureRoute(route(backendPort));
    const response = await new Promise((resolve, reject) => {
      const socket = net.connect(gateway.address().port, "127.0.0.1");
      let data = "";
      socket.once("error", reject);
      socket.on("data", (chunk) => {
        data += chunk.toString("utf8");
        if (data.includes("pong")) { socket.destroy(); resolve(data); }
      });
      socket.once("connect", () => socket.write(
        "GET /hmr HTTP/1.1\r\nHost: web.localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ZGV2c3BhY2U=\r\n\r\n"
      ));
    });
    assert.match(response, /101 Switching Protocols/u);
    assert.match(response, /pong/u);
  } finally {
    await gateway.close();
    await new Promise((resolve, reject) => backend.close((error) => error === undefined ? resolve() : reject(error)));
  }
});

test("fixture route and opaque probe reject non-loopback or unapproved inputs", async () => {
  const backend = http.createServer((_request, response) => response.writeHead(200).end("ok"));
  const backendPort = await listen(backend);
  const gateway = await createPreviewGatewayFixture();
  try {
    gateway.registerLease({ leaseId: "lease-1", hostPort: backendPort });
    assert.throws(() => gateway.ensureRoute({ ...route(backendPort), hostIp: "0.0.0.0" }), /lease-not-loopback/u);
    assert.throws(() => gateway.ensureRoute({ ...route(backendPort), hostname: "web.attacker.test" }), /hostname-not-approved/u);
    assert.deepEqual(await gateway.probe({
      leaseId: "lease-1", path: "/health", acceptedStatuses: [200], deadlineMs: 1_000,
      signal: new AbortController().signal, webSocketForwarding: true
    }), { kind: "response", statusCode: 200 });
    assert.equal((await gateway.probe({
      leaseId: "not-owned", path: "/health", acceptedStatuses: [200], deadlineMs: 1_000,
      signal: new AbortController().signal, webSocketForwarding: true
    })).kind, "infrastructure");
  } finally {
    await gateway.close();
    await new Promise((resolve, reject) => backend.close((error) => error === undefined ? resolve() : reject(error)));
  }
});

test("private probe resolves an opaque lease on the gateway side", async () => {
  const backend = http.createServer((_request, response) => response.writeHead(200).end("gateway-owned"));
  const backendPort = await listen(backend);
  const root = await mkdtemp(path.join(tmpdir(), "devspace-preview-gateway-test-"));
  const resolved = [];
  const gateway = await createPreviewGatewayFixture({
    adminSocketPath: path.join(root, "admin.sock"), probeSocketPath: path.join(root, "probe.sock"),
    resolveLease: async (leaseId) => {
      resolved.push(leaseId);
      return leaseId === "opaque-lease" ? { leaseId, hostIp: "127.0.0.1", hostPort: backendPort } : null;
    }
  });
  try {
    const result = await unixRequest(path.join(root, "probe.sock"), "POST", "/v1/preview/probe", {
      leaseId: "opaque-lease", path: "/health", acceptedStatuses: [200], deadlineMs: 1_000, webSocketForwarding: true
    });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, { kind: "response", statusCode: 200 });
    assert.deepEqual(resolved, ["opaque-lease"]);
    const foreign = await unixRequest(path.join(root, "probe.sock"), "POST", "/v1/preview/probe", {
      leaseId: "foreign-lease", hostIp: "127.0.0.1", hostPort: backendPort, path: "/health",
      acceptedStatuses: [200], deadlineMs: 1_000, webSocketForwarding: true
    });
    assert.deepEqual(foreign.body, { kind: "infrastructure", message: "The opaque preview lease is unavailable." });
    assert.deepEqual(resolved, ["opaque-lease", "foreign-lease"]);
    assert.deepEqual(gateway.probeEvents().map((event) => event.leaseId), ["opaque-lease", "foreign-lease"]);
  } finally {
    await gateway.close();
    await new Promise((resolve, reject) => backend.close((error) => error === undefined ? resolve() : reject(error)));
    await rm(root, { recursive: true, force: true });
  }
});

test("private admin transport models the exact Caddy route document", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devspace-preview-admin-test-"));
  const gateway = await createPreviewGatewayFixture({ adminSocketPath: path.join(root, "admin.sock") });
  const encode = (value) => Buffer.from(value, "utf8").toString("base64url");
  const expected = route(43210);
  const id = [expected.projectId, expected.workspaceId, expected.previewId, expected.revisionId, expected.approvedBaseId, expected.leaseId]
    .map(encode).join(".");
  try {
    const response = await unixRequest(path.join(root, "admin.sock"), "PATCH", "/config/apps/http/servers/devspace-preview/routes", [{
      "@id": `devspace-preview-v1.${id}.g1.ws1`, match: [{ host: [expected.hostname] }],
      handle: [{ handler: "reverse_proxy", upstreams: [{ dial: `${expected.hostIp}:${expected.hostPort}` }], flush_interval: -1 }], terminal: true
    }]);
    assert.equal(response.status, 204);
    assert.deepEqual(gateway.routes(), [expected]);
  } finally {
    await gateway.close();
    await rm(root, { recursive: true, force: true });
  }
});
