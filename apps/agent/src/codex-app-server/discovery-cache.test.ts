import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import type {
  CodexCapabilitySet,
  CodexCompatibilityFeatureResult,
  CodexFeature,
  CodexProbeRuntimeIdentity
} from "@devspace/contracts";
import { durableJsonWriter, type AtomicJsonWriter } from "../private-state.js";
import { CodexDiscoveryCache, type CodexDiscoveryCacheKey, type CodexDiscoveryCacheValue } from "./discovery-cache.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
});

const runtime: CodexProbeRuntimeIdentity = {
  imageId: `sha256:${"a".repeat(64)}`, operatingSystem: "linux", architecture: "amd64", containerUser: "1000:1000",
  policyVersion: "codex-probe-runtime-v1"
};
const capabilities: CodexCapabilitySet = {
  inspect: true, start: true, resume: true, sendTurn: true, interrupt: true, approvals: true,
  structuredInput: true, stop: true, streamEvents: true
};
const features = Object.fromEntries(([
  ["basicSession", "supported"], ["approvals", "supported"], ["structuredInput", "supported"], ["interrupt", "supported"]
] as const).map(([feature, state]) => [feature, { feature, state, reason: null }])) as Record<CodexFeature, CodexCompatibilityFeatureResult>;

function key(): CodexDiscoveryCacheKey {
  return {
    closureDigest: "a".repeat(64), probeRuntimeIdentity: runtime,
    schemaCommandContract: "codex-app-server-schema-v1", cacheFormat: "codex-discovery-cache-v1",
    semanticAdapterVersion: "codex-app-server-family-v1", compatibilityPolicyVersion: "codex-compatibility-v1"
  };
}

function value(): CodexDiscoveryCacheValue {
  return {
    key: key(), reportedVersion: "0.153.4", stableSchemaFingerprint: "b".repeat(64),
    experimentalSchemaFingerprint: "c".repeat(64), featureResults: features, capabilities, diagnostic: null
  };
}

async function cacheFixture(writer: AtomicJsonWriter = durableJsonWriter): Promise<{ root: string; cache: CodexDiscoveryCache }> {
  const root = await mkdtemp(path.join(tmpdir(), "devspace-codex-cache-")); roots.push(root);
  return { root, cache: new CodexDiscoveryCache(root, writer) };
}

test("writes and reads only bounded compatibility evidence, never raw schema content", async () => {
  const fixture = await cacheFixture();
  await fixture.cache.write(value());
  await expect(fixture.cache.read(key())).resolves.toEqual(value());
  const files = await readFile(path.join(fixture.root, "ai/codex-discovery-cache", `${key().closureDigest}.json`), "utf8");
  expect(files).not.toContain("schemaFiles");
  expect(files).not.toContain("rawParams");
  expect(files).not.toContain("nativeRequestId");
});

test("ignores corrupt, oversized, and mismatched cache entries", async () => {
  const fixture = await cacheFixture();
  const cachePath = path.join(fixture.root, "ai/codex-discovery-cache", `${key().closureDigest}.json`);
  await mkdir(path.dirname(cachePath), { recursive: true });
  await writeFile(cachePath, "not-json", "utf8");
  await expect(fixture.cache.read(key())).resolves.toBeNull();
  await writeFile(cachePath, "x".repeat(300_000), "utf8");
  await expect(fixture.cache.read(key())).resolves.toBeNull();
  await fixture.cache.write({ ...value(), key: { ...key(), semanticAdapterVersion: "different" } });
  await expect(fixture.cache.read(key())).resolves.toBeNull();
});

test("preserves atomic writer failure without exposing a partial cache", async () => {
  const fixture = await cacheFixture({
    async write() { throw new Error("injected-cache-write-failure"); }
  });
  await expect(fixture.cache.write(value())).rejects.toThrow("injected-cache-write-failure");
  await expect(fixture.cache.read(key())).resolves.toBeNull();
});
