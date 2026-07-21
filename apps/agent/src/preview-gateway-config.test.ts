import http from "node:http";
import { afterEach, expect, test } from "vitest";
import { readPreviewGatewayConfiguration } from "./preview-gateway-config.js";

const leaseId = "01900000-0000-7000-8000-000000000005";
const servers: http.Server[] = [];
const baseEnvironment = {
  DEVSPACE_CADDY_ADMIN_SOCKET: "/run/devspace/gateway/caddy-admin.sock",
  DEVSPACE_PREVIEW_BASES: JSON.stringify([{ id: "local", domain: "preview.example.com", labelSuffix: "-preview" }])
};

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => await new Promise<void>((resolve) => server.close(() => resolve()))));
});

async function listen(server: http.Server): Promise<number> {
  servers.push(server);
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("listener-address-missing");
  return address.port;
}

test("keeps the direct local probe topology when neither resolver nor private probe is configured", async () => {
  const target = http.createServer((_request, response) => response.writeHead(200).end("ready"));
  const hostPort = await listen(target);
  const configuration = readPreviewGatewayConfiguration(baseEnvironment);
  expect(configuration.previewGatewayFactory).toBeTypeOf("function");
  const gateway = configuration.previewGatewayFactory!(() => Promise.resolve({ leaseId, hostIp: "127.0.0.1", hostPort }));
  await expect(gateway.probe({ leaseId, path: "/health", acceptedStatuses: [200], deadlineMs: 100, webSocketForwarding: false,
    signal: new AbortController().signal })).resolves.toEqual({ kind: "response", statusCode: 200 });
});

test("rejects a resolver configuration without the cross-namespace probe socket", () => {
  expect(() => readPreviewGatewayConfiguration({ ...baseEnvironment,
    DEVSPACE_PREVIEW_LEASE_RESOLVER_SOCKET: "/run/devspace/gateway/lease-resolver.sock" }))
    .toThrow("DEVSPACE_PREVIEW_LEASE_RESOLVER_SOCKET requires DEVSPACE_PREVIEW_PROBE_SOCKET.");
});

test("accepts the resolver and private probe sockets together", () => {
  const configuration = readPreviewGatewayConfiguration({ ...baseEnvironment,
    DEVSPACE_PREVIEW_LEASE_RESOLVER_SOCKET: "/run/devspace/gateway/lease-resolver.sock",
    DEVSPACE_PREVIEW_PROBE_SOCKET: "/run/devspace/gateway/preview-probe.sock" });
  expect(configuration.previewLeaseResolverSocket).toBe("/run/devspace/gateway/lease-resolver.sock");
  expect(configuration.previewProbeSocket).toBe("/run/devspace/gateway/preview-probe.sock");
  expect(configuration.previewGatewayFactory).toBeTypeOf("function");
});

test.each([
  ["blank probe socket", { DEVSPACE_PREVIEW_PROBE_SOCKET: "" }, "non-empty"],
  ["probe socket without Caddy admin", { DEVSPACE_PREVIEW_PROBE_SOCKET: "/run/devspace/gateway/preview-probe.sock", DEVSPACE_CADDY_ADMIN_SOCKET: undefined }, "requires DEVSPACE_CADDY_ADMIN_SOCKET"],
  ["probe socket without preview bases", { DEVSPACE_PREVIEW_PROBE_SOCKET: "/run/devspace/gateway/preview-probe.sock", DEVSPACE_PREVIEW_BASES: undefined }, "requires DEVSPACE_CADDY_ADMIN_SOCKET"]
] as const)("retains rejection for an invalid %s", (_name, overrides, message) => {
  expect(() => readPreviewGatewayConfiguration({ ...baseEnvironment, ...overrides })).toThrow(message);
});
