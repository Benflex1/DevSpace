import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "vitest";
import {
  CaddyAdminHttpTransport,
  CaddyGatewayClient,
  GatewayAdapterError,
  GatewayHostProbe,
  GatewayHostProbeServer,
  GatewayOperationError,
  LOOPBACK_HOST,
  PreviewGatewayAdapter,
  PrivateCaddyAdminTransport,
  PrivateGatewayProbeTransport,
  fromCaddyRoutes,
  toCaddyRoute,
  type CaddyAdminTransport,
  type PreviewGatewayRoute
} from "./index.js";

const policy = { approvedPreviewBases: [{ id: "local", domain: "localhost" }] } as const;
const approved = (hostname: string) => hostname.endsWith(".localhost");
const ids = {
  projectId: "01900000-0000-7000-8000-000000000001",
  workspaceId: "01900000-0000-7000-8000-000000000002",
  previewId: "01900000-0000-7000-8000-000000000003",
  revisionId: "01900000-0000-7000-8000-000000000004",
  leaseId: "01900000-0000-7000-8000-000000000005"
} as const;

function route(overrides: Partial<PreviewGatewayRoute> = {}): PreviewGatewayRoute {
  return {
    ...ids, generation: 1, hostname: "web.localhost", approvedBaseId: "local",
    hostIp: LOOPBACK_HOST, hostPort: 43123, webSocketForwarding: true, ...overrides
  };
}

class MemoryTransport implements CaddyAdminTransport {
  documents: readonly unknown[] = [];
  replaceCount = 0;
  failReads = false;

  async request(method: "GET" | "PUT", _path: string, body?: readonly unknown[]) {
    if (this.failReads && method === "GET") throw new Error("http://127.0.0.1:2019 unavailable");
    if (method === "PUT") { this.documents = body ?? []; this.replaceCount += 1; return { statusCode: 204, body: null }; }
    return { statusCode: 200, body: this.documents };
  }
}

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, LOOPBACK_HOST, resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("server-address-missing");
  return address.port;
}

function probeInput(overrides: Partial<{
  readonly leaseId: string;
  readonly path: string;
  readonly acceptedStatuses: readonly number[];
  readonly deadlineMs: number;
  readonly webSocketForwarding: boolean;
}> = {}) {
  return {
    leaseId: ids.leaseId, path: "/health", acceptedStatuses: [200], deadlineMs: 1_000,
    signal: new AbortController().signal, webSocketForwarding: false, ...overrides
  } as const;
}

async function createSocketServer(handler: http.RequestListener): Promise<{ readonly directory: string; readonly socketPath: string; readonly server: http.Server }> {
  const directory = await mkdtemp(join(tmpdir(), "devspace-gateway-probe-"));
  const socketPath = join(directory, "probe.sock");
  const server = http.createServer(handler);
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });
  return { directory, socketPath, server };
}

async function closeSocketServer(fixture: { readonly directory: string; readonly server: http.Server }): Promise<void> {
  await new Promise<void>((resolve, reject) => fixture.server.close((error) => error === undefined ? resolve() : reject(error)));
  await rm(fixture.directory, { recursive: true, force: true });
}

async function requestSocket(socketPath: string, body: unknown): Promise<{ readonly status: number; readonly body: string }> {
  return await new Promise((resolve, reject) => {
    const wireBody = typeof body === "object" && body !== null
      ? Object.fromEntries(Object.entries(body).filter(([key]) => key !== "signal")) : body;
    const encoded = JSON.stringify(wireBody);
    const request = http.request({ socketPath, method: "POST", path: "/v1/preview/probe",
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(encoded) } }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
    });
    request.once("error", reject);
    request.end(encoded);
  });
}

describe("typed private Caddy gateway adapter", () => {
  test("generates an exact host route with only a loopback upstream and streaming/upgrade support", () => {
    const document = toCaddyRoute(route(), policy);
    expect(document.match).toEqual([{ host: ["web.localhost"] }]);
    expect(document.handle[0]).toEqual({
      handler: "reverse_proxy", upstreams: [{ dial: "127.0.0.1:43123" }], flush_interval: -1
    });
    expect(document.terminal).toBe(true);
    expect(fromCaddyRoutes([document], approved)).toEqual([{ kind: "managed", route: route() }]);
  });

  test.each([
    { hostIp: "0.0.0.0", message: "public host address" },
    { hostIp: "::1", message: "IPv6 host address" },
    { hostname: "web.attacker.test", message: "unapproved hostname" },
    { approvedBaseId: "other", message: "hostname/base identity mismatch" },
    { arbitraryUpstream: "127.0.0.1:43123", message: "raw upstream field" }
  ])("rejects $message route input", ({ message: _message, ...change }) => {
    expect(() => toCaddyRoute({ ...route(), ...change } as PreviewGatewayRoute, policy)).toThrow(GatewayAdapterError);
  });

  test("reconciles exact route identity and removes foreign/stale routes", async () => {
    const transport = new MemoryTransport();
    const oldRoute = route({ leaseId: "01900000-0000-7000-8000-000000000006", hostPort: 43124 });
    transport.documents = [{ "@id": "foreign-route", match: [{ host: ["stale.localhost"] }] }, toCaddyRoute(oldRoute, approved)];
    const adapter = new CaddyGatewayClient(transport, { isApprovedHostname: approved });
    await adapter.reconcileRoutes([route()]);
    expect(fromCaddyRoutes(transport.documents, approved)).toEqual([{ kind: "managed", route: route() }]);
    expect((await adapter.inspectRoute(route())).present).toBe(true);
    expect((await adapter.inspectRoute(oldRoute)).present).toBe(false);
    expect(transport.replaceCount).toBe(1);
  });

  test("reports same-resource lease drift as stale", async () => {
    const transport = new MemoryTransport();
    const current = route({ hostPort: 43124 });
    transport.documents = [toCaddyRoute(current, approved)];
    const adapter = new CaddyGatewayClient(transport, { isApprovedHostname: approved });
    expect(await adapter.inspectRoute(route())).toMatchObject({ present: false, status: "stale" });
  });

  test("bounds unexpected private admin failures", async () => {
    const transport = new MemoryTransport();
    transport.failReads = true;
    const adapter = new CaddyGatewayClient(transport, { isApprovedHostname: approved });
    await expect(adapter.inspectRoute(route())).rejects.toMatchObject({ code: "ADMIN_UNAVAILABLE", stage: "admin" });
    try { await adapter.inspectRoute(route()); } catch (error) {
      expect(error).toBeInstanceOf(GatewayOperationError);
      expect((error as Error).message.length).toBeLessThanOrEqual(256);
      expect((error as Error).message).not.toContain("http://127.0.0.1:2019");
    }
  });

  test("requires a private Unix-socket admin transport", () => {
    expect(() => new PrivateCaddyAdminTransport({ socketPath: "   " })).toThrow(GatewayAdapterError);
  });

  test("provides the opaque lease probe and stable combined adapter methods", async () => {
    let targetRequests = 0;
    const server = http.createServer((_request, response) => { targetRequests += 1; response.writeHead(200).end("ready"); });
    const hostPort = await listen(server);
    try {
      const resolveLease = async (leaseId: string) => leaseId === ids.leaseId
        ? { leaseId, hostIp: LOOPBACK_HOST, hostPort } : null;
      const adapter = new PreviewGatewayAdapter({ transport: new MemoryTransport(), policy, probe: new GatewayHostProbe(resolveLease) });
      const probeInput = {
        leaseId: ids.leaseId, path: "/health", acceptedStatuses: [200], deadlineMs: 1_000,
        signal: new AbortController().signal, webSocketForwarding: true
      } as const;
      expect(await new GatewayHostProbe(resolveLease).probe(probeInput)).toEqual({ kind: "response", statusCode: 200 });
      expect(targetRequests).toBe(1);
      expect(await adapter.probe(probeInput)).toEqual({ kind: "response", statusCode: 200 });
      expect(targetRequests).toBe(2);
      expect(typeof adapter.ensureRoute).toBe("function");
      expect(typeof adapter.replaceRoute).toBe("function");
      expect(typeof adapter.removeRoute).toBe("function");
      expect(typeof adapter.inspectRoute).toBe("function");
      expect(typeof adapter.reconcileRoutes).toBe("function");
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
    }
  });

  test("Agent-side adapter never opens the lease loopback; only the host-side probe does", async () => {
    let targetRequests = 0;
    const server = http.createServer((_request, response) => { targetRequests += 1; response.writeHead(200).end("ready"); });
    const hostPort = await listen(server);
    try {
      const resolveLease = async (leaseId: string) => leaseId === ids.leaseId
        ? { leaseId, hostIp: LOOPBACK_HOST, hostPort } : null;
      const hostProbe = new GatewayHostProbe(resolveLease);
      const boundaryCalls: string[] = [];
      const adapter = new PreviewGatewayAdapter({ transport: new MemoryTransport(), policy,
        probe: { probe: async (input) => { boundaryCalls.push(input.leaseId); return { kind: "response", statusCode: 200 }; } } });
      const input = { leaseId: ids.leaseId, path: "/health", acceptedStatuses: [200], deadlineMs: 1_000,
        signal: new AbortController().signal, webSocketForwarding: false } as const;
      expect(await adapter.probe(input)).toEqual({ kind: "response", statusCode: 200 });
      expect(boundaryCalls).toEqual([ids.leaseId]);
      expect(targetRequests).toBe(0);
      expect(await hostProbe.probe(input)).toEqual({ kind: "response", statusCode: 200 });
      expect(targetRequests).toBe(1);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
    }
  });

  test("private transport sends only the closed typed request over the configured Unix socket", async () => {
    let wireBody: unknown;
    const socket = await createSocketServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        wireBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        const result = JSON.stringify({ kind: "response", statusCode: 200 });
        response.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(result) }).end(result);
      });
    });
    try {
      const result = await new PrivateGatewayProbeTransport({ socketPath: socket.socketPath }).probe(probeInput({
        path: "/healthz", acceptedStatuses: [200, 204], deadlineMs: 250, webSocketForwarding: true
      }));
      expect(result).toEqual({ kind: "response", statusCode: 200 });
      expect(wireBody).toEqual({ leaseId: ids.leaseId, path: "/healthz", acceptedStatuses: [200, 204], deadlineMs: 250, webSocketForwarding: true });
      expect(JSON.stringify(wireBody)).not.toMatch(/host|ip|port|url|upstream/iu);
    } finally { await closeSocketServer(socket); }
  });

  test("private-socket mode never opens the lease loopback from the Agent side", async () => {
    let targetRequests = 0;
    const target = http.createServer((_request, response) => { targetRequests += 1; response.writeHead(200).end("must-not-be-called"); });
    await listen(target);
    const socket = await createSocketServer((_request, response) => {
      const result = JSON.stringify({ kind: "response", statusCode: 200 });
      response.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(result) }).end(result);
    });
    try {
      const result = await new PrivateGatewayProbeTransport({ socketPath: socket.socketPath }).probe(probeInput());
      expect(result).toEqual({ kind: "response", statusCode: 200 });
      expect(targetRequests).toBe(0);
    } finally {
      await closeSocketServer(socket);
      await new Promise<void>((resolve, reject) => target.close((error) => error === undefined ? resolve() : reject(error)));
    }
  });

  test("private transport reports an unavailable socket as infrastructure failure", async () => {
    const directory = await mkdtemp(join(tmpdir(), "devspace-gateway-probe-"));
    try {
      const result = await new PrivateGatewayProbeTransport({ socketPath: join(directory, "missing.sock"), timeoutMs: 50 }).probe(probeInput());
      expect(result).toEqual({ kind: "infrastructure", message: "The private gateway probe is unavailable." });
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  test.each([
    { name: "malformed", body: "not-json" },
    { name: "oversized", body: "x".repeat(16_385) }
  ])("private transport fails closed for a $name response", async ({ body }) => {
    const socket = await createSocketServer((_request, response) => response.writeHead(200).end(body));
    try {
      const result = await new PrivateGatewayProbeTransport({ socketPath: socket.socketPath, timeoutMs: 100 }).probe(probeInput());
      expect(result).toEqual({ kind: "infrastructure", message: body === "not-json"
        ? "The private gateway probe returned an invalid result."
        : "The private gateway probe is unavailable." });
    } finally { await closeSocketServer(socket); }
  });

  test("private transport bounds cancellation and deadline", async () => {
    const socket = await createSocketServer((_request, _response) => { /* leave the response pending */ });
    try {
      const started = Date.now();
      const result = await new PrivateGatewayProbeTransport({ socketPath: socket.socketPath, timeoutMs: 40 }).probe(probeInput({ deadlineMs: 20 }));
      expect(result).toEqual({ kind: "timeout" });
      expect(Date.now() - started).toBeLessThan(500);
      const controller = new AbortController();
      const cancellation = new PrivateGatewayProbeTransport({ socketPath: socket.socketPath, timeoutMs: 1_000 }).probe({
        ...probeInput({ deadlineMs: 1_000 }), signal: controller.signal
      });
      setTimeout(() => controller.abort(), 10);
      await expect(cancellation).resolves.toEqual({ kind: "timeout" });
    } finally { await closeSocketServer(socket); }
  });

  test("host probe service accepts only the closed request and resolves unknown leases server-side", async () => {
    const directory = await mkdtemp(join(tmpdir(), "devspace-gateway-probe-"));
    const socketPath = join(directory, "probe.sock");
    const resolved: string[] = [];
    const service = new GatewayHostProbeServer({ socketPath, resolveLease: async (leaseId) => { resolved.push(leaseId); return null; } });
    await service.start();
    try {
      const invalid = await requestSocket(socketPath, { ...probeInput(), host: "127.0.0.1", port: 43123 });
      expect(invalid.status).toBe(400);
      expect(resolved).toEqual([]);
      const unknown = await requestSocket(socketPath, probeInput());
      expect(unknown.status).toBe(200);
      expect(JSON.parse(unknown.body)).toEqual({ kind: "infrastructure", message: "The opaque preview lease is unavailable." });
      expect(resolved).toEqual([ids.leaseId]);
    } finally { await service.stop(); await rm(directory, { recursive: true, force: true }); }
  });

  test("host probe service rejects non-loopback leases and probes only after trusted resolution", async () => {
    let targetRequests = 0;
    let resolved = false;
    const target = http.createServer((_request, response) => {
      targetRequests += 1;
      expect(resolved).toBe(true);
      response.writeHead(200).end("ready");
    });
    const hostPort = await listen(target);
    const directory = await mkdtemp(join(tmpdir(), "devspace-gateway-probe-"));
    const socketPath = join(directory, "probe.sock");
    const service = new GatewayHostProbeServer({ socketPath, resolveLease: async (leaseId) => {
      resolved = true;
      if (leaseId === "01900000-0000-7000-8000-000000000006") return { leaseId, hostIp: "10.0.0.1", hostPort } as never;
      return { leaseId, hostIp: LOOPBACK_HOST, hostPort };
    } });
    await service.start();
    try {
      const rejected = await requestSocket(socketPath, { ...probeInput(), leaseId: "01900000-0000-7000-8000-000000000006" });
      expect(JSON.parse(rejected.body)).toEqual({ kind: "infrastructure", message: "The opaque preview lease is unavailable." });
      expect(targetRequests).toBe(0);
      resolved = false;
      const accepted = await requestSocket(socketPath, probeInput());
      expect(JSON.parse(accepted.body)).toEqual({ kind: "response", statusCode: 200 });
      expect(targetRequests).toBe(1);
    } finally {
      await service.stop();
      await rm(directory, { recursive: true, force: true });
      await new Promise<void>((resolve, reject) => target.close((error) => error === undefined ? resolve() : reject(error)));
    }
  });

  test("Caddy HTTP transport is loopback-only and emits generated route JSON", async () => {
    expect(() => new CaddyAdminHttpTransport({ adminUrl: "http://gateway.example.test:2019" }, policy)).toThrow(GatewayAdapterError);
    const document = toCaddyRoute(route(), policy);
    const calls: Array<{ url: string; method: string; body: string | undefined }> = [];
    const transport = new CaddyAdminHttpTransport({
      adminUrl: "http://127.0.0.1:2019",
      fetch: async (url, init) => {
        calls.push({ url: String(url), method: init?.method ?? "GET", body: typeof init?.body === "string" ? init.body : undefined });
        return init?.method === "PUT" ? new Response(null, { status: 204 }) : Response.json([document]);
      }
    }, policy);
    expect((await transport.request("GET", "/config/apps/http/servers/devspace-preview/routes")).statusCode).toBe(200);
    await transport.request("PUT", "/config/apps/http/servers/devspace-preview/routes", [document]);
    expect(calls).toHaveLength(2);
    expect(JSON.parse(calls[1]!.body!)[0].handle[0].upstreams).toEqual([{ dial: "127.0.0.1:43123" }]);
  });
});
