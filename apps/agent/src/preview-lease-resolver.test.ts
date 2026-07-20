import { lstat, mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  GatewayHostProbeServer,
  PrivatePreviewLeaseResolverTransport,
  type PreviewGatewayLease
} from "@devspace/gateway-caddy";
import { PreviewLeaseResolverServer } from "./preview-lease-resolver.js";

const lease: PreviewGatewayLease = {
  leaseId: "01900000-0000-7000-8000-000000000005",
  hostIp: "127.0.0.1",
  hostPort: 41234
};
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true }))); });

async function requestSocket(socketPath: string, body: unknown): Promise<{ readonly status: number; readonly body: unknown }> {
  const encoded = typeof body === "string" ? body : JSON.stringify(body);
  return await new Promise((resolve, reject) => {
    const request = http.request({ socketPath, method: "POST", path: "/v1/preview/lease/resolve",
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(encoded) } }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve({ status: response.statusCode ?? 0, body: JSON.parse(raw) });
      });
    });
    request.once("error", reject);
    request.end(encoded);
  });
}

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("listener-address-missing");
  return address.port;
}

async function close(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
}

describe("private Agent preview lease resolver", () => {
  test("resolves an Agent-owned lease to exactly leaseId, loopback host, and hostPort", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "devspace-preview-lease-resolver-")); roots.push(root);
    const socketPath = path.join(root, "resolver.sock");
    const resolveLease = vi.fn((leaseId: string) => Promise.resolve(leaseId === lease.leaseId ? lease : null));
    const server = new PreviewLeaseResolverServer({ socketPath, resolveLease });
    await server.start();
    try {
      const response = await requestSocket(socketPath, { leaseId: lease.leaseId });
      expect(response.status).toBe(200);
      expect(response.body).toEqual(lease);
      expect(Object.keys(response.body as object).sort()).toEqual(["hostIp", "hostPort", "leaseId"]);
      expect(resolveLease).toHaveBeenCalledWith(lease.leaseId);
      expect((await lstat(socketPath)).mode & 0o007).toBe(0);
    } finally { await server.stop(); }
  });

  test("fails closed for unknown leases, malformed bodies, and caller-supplied routing fields", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "devspace-preview-lease-resolver-")); roots.push(root);
    const socketPath = path.join(root, "resolver.sock");
    const resolveLease = vi.fn((leaseId: string) => Promise.resolve(leaseId === lease.leaseId ? lease : null));
    const server = new PreviewLeaseResolverServer({ socketPath, resolveLease });
    await server.start();
    try {
      await expect(requestSocket(socketPath, { leaseId: "01900000-0000-7000-8000-000000000006" })).resolves.toMatchObject({ status: 404 });
      await expect(requestSocket(socketPath, { leaseId: "not-a-lease-uuid" })).resolves.toMatchObject({ status: 400 });
      await expect(requestSocket(socketPath, "not-json")).resolves.toMatchObject({ status: 400 });
      await expect(requestSocket(socketPath, { leaseId: lease.leaseId, hostIp: "10.0.0.1", hostPort: 80 })).resolves.toMatchObject({ status: 400 });
      await expect(requestSocket(socketPath, { leaseId: lease.leaseId, unknown: true })).resolves.toMatchObject({ status: 400 });
      await expect(requestSocket(socketPath, "x".repeat(4_097))).resolves.toEqual({
        status: 400, body: { error: "invalid_request" }
      });
      expect(resolveLease).toHaveBeenCalledTimes(1);
      expect(resolveLease).toHaveBeenCalledWith("01900000-0000-7000-8000-000000000006");
    } finally { await server.stop(); }
  });

  test("rejects an invalid authority result rather than returning private state", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "devspace-preview-lease-resolver-")); roots.push(root);
    const socketPath = path.join(root, "resolver.sock");
    const server = new PreviewLeaseResolverServer({ socketPath,
      resolveLease: () => Promise.reject(new Error("authority-failure")) });
    await server.start();
    try {
      await expect(requestSocket(socketPath, { leaseId: lease.leaseId })).resolves.toEqual({
        status: 404, body: { error: "preview_lease_unavailable" }
      });
    }
    finally { await server.stop(); }
  });

  test("returns one unavailable result for an invalid authority result and bounds oversized responses", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "devspace-preview-lease-resolver-")); roots.push(root);
    const socketPath = path.join(root, "resolver.sock");
    const oversized = { ...lease, hostPort: 40_000, extra: "x".repeat(2_000) };
    const server = new PreviewLeaseResolverServer({ socketPath,
      resolveLease: () => Promise.resolve(oversized) });
    await server.start();
    try {
      await expect(requestSocket(socketPath, { leaseId: lease.leaseId })).resolves.toEqual({
        status: 404, body: { error: "preview_lease_unavailable" }
      });
    } finally { await server.stop(); }
  });

  test("cleans the bound resolver socket after a post-bind startup failure", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "devspace-preview-lease-resolver-")); roots.push(root);
    const socketPath = path.join(root, "resolver.sock");
    const server = new PreviewLeaseResolverServer({ socketPath, resolveLease: () => Promise.resolve(null),
      afterBind: () => Promise.reject(new Error("forced post-bind failure")) });
    await expect(server.start()).rejects.toThrow("forced post-bind failure");
    await expect(lstat(socketPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(`${socketPath}.lock`)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("serializes concurrent resolver ownership attempts and supports repeated start/stop", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "devspace-preview-lease-resolver-")); roots.push(root);
    const socketPath = path.join(root, "resolver.sock");
    const first = new PreviewLeaseResolverServer({ socketPath, resolveLease: () => Promise.resolve(null) });
    const second = new PreviewLeaseResolverServer({ socketPath, resolveLease: () => Promise.resolve(null) });
    const results = await Promise.allSettled([first.start(), second.start()]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const winner = results[0].status === "fulfilled" ? first : second;
    await winner.start();
    await winner.stop();
    await winner.stop();
    await expect(lstat(socketPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("completes the resolver-to-host-probe chain over temporary Unix sockets", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "devspace-preview-lease-chain-")); roots.push(root);
    const resolverSocketPath = path.join(root, "resolver.sock");
    const probeSocketPath = path.join(root, "probe.sock");
    const target = http.createServer((request, response) => {
      if (request.url !== "/health") { response.writeHead(404).end(); return; }
      response.writeHead(200).end("healthy");
    });
    const hostPort = await listen(target);
    const ownedLease = { ...lease, hostPort };
    const resolverServer = new PreviewLeaseResolverServer({ socketPath: resolverSocketPath,
      resolveLease: (leaseId) => Promise.resolve(leaseId === ownedLease.leaseId ? ownedLease : null) });
    const resolverTransport = new PrivatePreviewLeaseResolverTransport({ socketPath: resolverSocketPath });
    const probeServer = new GatewayHostProbeServer({ socketPath: probeSocketPath,
      resolveLease: async (leaseId) => await resolverTransport.resolveLease(leaseId) });
    await resolverServer.start();
    await probeServer.start();
    try {
      const encoded = JSON.stringify({ leaseId: ownedLease.leaseId, path: "/health", acceptedStatuses: [200], deadlineMs: 500, webSocketForwarding: false });
      const result = await new Promise<{ readonly status: number; readonly body: unknown }>((resolve, reject) => {
        const request = http.request({ socketPath: probeSocketPath, method: "POST", path: "/v1/preview/probe",
          headers: { "content-type": "application/json", "content-length": Buffer.byteLength(encoded) } }, (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.on("end", () => resolve({ status: response.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) }));
        });
        request.once("error", reject);
        request.end(encoded);
      });
      expect(result).toEqual({ status: 200, body: { kind: "response", statusCode: 200 } });
    } finally {
      await probeServer.stop();
      await resolverServer.stop();
      await close(target);
    }
  });
});
