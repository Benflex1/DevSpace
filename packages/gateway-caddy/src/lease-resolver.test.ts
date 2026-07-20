import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { PrivatePreviewLeaseResolverTransport, type PreviewGatewayLease } from "./index.js";

const lease: PreviewGatewayLease = {
  leaseId: "01900000-0000-7000-8000-000000000005",
  hostIp: "127.0.0.1",
  hostPort: 41234
};
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true }))); });

async function socketServer(handler: http.RequestListener): Promise<{ readonly root: string; readonly path: string; readonly server: http.Server }> {
  const root = await mkdtemp(join(tmpdir(), "devspace-lease-resolver-client-"));
  roots.push(root);
  const path = join(root, "resolver.sock");
  const server = http.createServer(handler);
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(path, resolve); });
  return { root, path, server };
}

async function closeServer(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
}

async function readBody(request: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk as Uint8Array));
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function respond(response: http.ServerResponse, body: unknown, status = 200): void {
  const encoded = JSON.stringify(body);
  response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(encoded) }).end(encoded);
}

describe("private preview lease resolver transport", () => {
  test("sends only the lease ID and parses the exact three-field response", async () => {
    let body: unknown;
    const fixture = await socketServer((request, response) => {
      void readBody(request).then((value) => {
        body = value;
        respond(response, lease);
      }).catch(() => response.destroy());
    });
    try {
      await expect(new PrivatePreviewLeaseResolverTransport({ socketPath: fixture.path }).resolveLease(lease.leaseId)).resolves.toEqual(lease);
      expect(body).toEqual({ leaseId: lease.leaseId });
    } finally { await closeServer(fixture.server); }
  });

  test.each([
    ["mismatched lease ID", { ...lease, leaseId: "01900000-0000-7000-8000-000000000006" }],
    ["non-loopback host", { ...lease, hostIp: "10.0.0.1" }],
    ["extra response field", { ...lease, privateState: "must-not-cross" }]
  ])("rejects a resolver response with a $0", async (_reason, body) => {
    const fixture = await socketServer((_request, response) => respond(response, body));
    try {
      await expect(new PrivatePreviewLeaseResolverTransport({ socketPath: fixture.path }).resolveLease(lease.leaseId)).resolves.toBeNull();
    } finally { await closeServer(fixture.server); }
  });

  test("fails closed for malformed, non-success, unavailable, and timed-out sockets", async () => {
    const malformed = await socketServer((_request, response) => response.writeHead(200).end("not-json"));
    try {
      await expect(new PrivatePreviewLeaseResolverTransport({ socketPath: malformed.path }).resolveLease(lease.leaseId)).resolves.toBeNull();
    } finally { await closeServer(malformed.server); }

    const rejected = await socketServer((_request, response) => respond(response, { error: "no" }, 503));
    try {
      await expect(new PrivatePreviewLeaseResolverTransport({ socketPath: rejected.path }).resolveLease(lease.leaseId)).resolves.toBeNull();
    } finally { await closeServer(rejected.server); }

    const missing = join(malformed.root, "missing.sock");
    await expect(new PrivatePreviewLeaseResolverTransport({ socketPath: missing, timeoutMs: 40 }).resolveLease(lease.leaseId)).resolves.toBeNull();

    const hanging = await socketServer((_request, _response) => { /* bounded transport timeout owns this connection */ });
    try {
      await expect(new PrivatePreviewLeaseResolverTransport({ socketPath: hanging.path, timeoutMs: 30 }).resolveLease(lease.leaseId)).resolves.toBeNull();
    } finally { await closeServer(hanging.server); }
  });
});
