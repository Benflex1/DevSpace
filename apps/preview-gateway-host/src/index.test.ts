import { lstat, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { createPreviewGatewayHostRuntime } from "./runtime.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
});

test("host probe runtime starts and shuts down without a public listener", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devspace-preview-gateway-host-"));
  roots.push(root);
  const probeSocketPath = path.join(root, "preview-probe.sock");
  const resolverSocketPath = path.join(root, "lease-resolver.sock");
  const runtime = createPreviewGatewayHostRuntime({ probeSocketPath, leaseResolverSocketPath: resolverSocketPath });

  await runtime.start();
  expect((await lstat(probeSocketPath)).isSocket()).toBe(true);
  await expect(lstat(resolverSocketPath)).rejects.toMatchObject({ code: "ENOENT" });
  await runtime.stop();
  await expect(lstat(probeSocketPath)).rejects.toMatchObject({ code: "ENOENT" });
});
