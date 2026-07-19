import http from "node:http";
import { describe, expect, test } from "vitest";
import {
  CaddyAdminHttpTransport,
  CaddyGatewayClient,
  GatewayAdapterError,
  GatewayHostProbe,
  GatewayOperationError,
  LOOPBACK_HOST,
  PreviewGatewayAdapter,
  PrivateCaddyAdminTransport,
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
    const server = http.createServer((_request, response) => response.writeHead(200).end("ready"));
    const hostPort = await listen(server);
    try {
      const resolveLease = async (leaseId: string) => leaseId === ids.leaseId
        ? { leaseId, hostIp: LOOPBACK_HOST, hostPort } : null;
      const adapter = new PreviewGatewayAdapter({ transport: new MemoryTransport(), policy, resolveLease });
      const probeInput = {
        leaseId: ids.leaseId, path: "/health", acceptedStatuses: [200], deadlineMs: 1_000,
        signal: new AbortController().signal, webSocketForwarding: true
      } as const;
      expect(await new GatewayHostProbe(resolveLease).probe(probeInput)).toEqual({ kind: "response", statusCode: 200 });
      expect(await adapter.probe(probeInput)).toEqual({ kind: "response", statusCode: 200 });
      expect(typeof adapter.ensureRoute).toBe("function");
      expect(typeof adapter.replaceRoute).toBe("function");
      expect(typeof adapter.removeRoute).toBe("function");
      expect(typeof adapter.inspectRoute).toBe("function");
      expect(typeof adapter.reconcileRoutes).toBe("function");
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
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
