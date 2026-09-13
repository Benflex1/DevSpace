import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import type { DockerEngineClient } from "../docker-runtime.js";
import type { WorkspaceExecutionContext } from "../managed-workspaces.js";
import type { CodexProbeRuntime, CodexProbeResult } from "./probe-runtime.js";
import { discoverCodex, parseCodexVersion } from "./discovery.js";
import type { CodexProbeRuntimeIdentity } from "@devspace/contracts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
});

const imageId = `sha256:${"a".repeat(64)}`;
const baseRuntime: CodexProbeRuntimeIdentity = {
  imageId, operatingSystem: "linux", architecture: "amd64", containerUser: "1000:1000", policyVersion: "codex-probe-runtime-v1"
};

async function nativeFixture(): Promise<{ root: string; executable: string; state: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "devspace-codex-discovery-")); roots.push(root);
  const state = path.join(root, "state");
  const executable = path.join(root, "codex");
  await writeFile(executable, Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]), Buffer.alloc(64, 17)]), { mode: 0o755 });
  await chmod(executable, 0o755);
  return { root, executable, state };
}

async function schemaFiles(): Promise<ReadonlyMap<string, Uint8Array>> {
  const fixtureRoot = path.resolve("packages/contracts/fixtures/codex-app-server/0.145.0");
  const files = [
    "stable/ClientRequest.json", "stable/ClientNotification.json", "stable/ServerRequest.json",
    "stable/ServerNotification.json", "experimental/ToolRequestUserInputParams.json"
  ];
  return new Map(await Promise.all(files.map(async (file) => [file, await readFile(path.join(fixtureRoot, file))] as const)));
}

function workspaceContext(): WorkspaceExecutionContext {
  return { projectId: "018f0f00-0000-7000-8000-000000000001", workspaceId: "018f0f00-0000-7000-8000-000000000002",
    revisionId: "018f0f00-0000-7000-8000-000000000003", revisionHash: "sha256-jcs-v1:revision", runtimePlanHash: "sha256-jcs-v1:runtime",
    generation: 1, ownership: { developmentContainer: { id: "managed-container" } } } as never;
}

function probeFixture(options: { readonly version?: string; readonly runtime?: CodexProbeRuntimeIdentity; readonly delayMs?: number } = {}): {
  readonly probe: CodexProbeRuntime;
  readonly calls: { count: number };
} {
  const calls = { count: 0 };
  const runtime = options.runtime ?? baseRuntime;
  const probe: CodexProbeRuntime = {
    inspect: async () => runtime,
    probe: async (): Promise<CodexProbeResult> => {
      calls.count += 1;
      if (options.delayMs !== undefined) await new Promise((resolve) => setTimeout(resolve, options.delayMs));
      return { runtime, versionOutput: `codex-cli ${options.version ?? "0.153.4"}`, schemaFiles: await schemaFiles() };
    }
  };
  return { probe, calls };
}

function discoveryInput(fixture: Awaited<ReturnType<typeof nativeFixture>>, probe: CodexProbeRuntime) {
  return {
    configuredPath: fixture.executable, managedContainerId: "managed-container", workspaceContext: workspaceContext(),
    stateRoot: fixture.state, docker: {} as DockerEngineClient, createId: () => "018f0f00-0000-7000-8000-000000000004", probeRuntime: probe
  };
}

test("parses only the supported version form and accepts newer versions without an upper bound", () => {
  expect(parseCodexVersion("codex-cli 0.145.0")).toBe("0.145.0");
  expect(parseCodexVersion("codex-cli 0.153.4")).toBe("0.153.4");
  expect(parseCodexVersion("Codex 0.160.1")).toBe("0.160.1");
  expect(parseCodexVersion("codex-cli unknown")).toBeNull();
  expect(parseCodexVersion("0.153.4 with secret stderr")).toBeNull();
});

test("caches compatibility evidence while re-resolving the exact source artifact", async () => {
  const fixture = await nativeFixture();
  const probeFixtureValue = probeFixture();
  const input = discoveryInput(fixture, probeFixtureValue.probe);
  const first = await discoverCodex(input);
  const second = await discoverCodex(input);
  expect(probeFixtureValue.calls.count).toBe(1);
  expect(second.compatibility.stableSchemaFingerprint).toBe(first.compatibility.stableSchemaFingerprint);
  expect(second.profileAuthority.executionArtifactClosureDigest).toBe(first.profileAuthority.executionArtifactClosureDigest);

  await writeFile(fixture.executable, Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]), Buffer.alloc(64, 18)]), { mode: 0o755 });
  const third = await discoverCodex(input);
  expect(probeFixtureValue.calls.count).toBe(2);
  expect(third.profileAuthority.executionArtifactClosureDigest).not.toBe(first.profileAuthority.executionArtifactClosureDigest);
});

test("invalidates cache evidence when probe runtime identity changes", async () => {
  const fixture = await nativeFixture();
  let current = baseRuntime;
  const calls = { count: 0 };
  const probe: CodexProbeRuntime = {
    inspect: async () => current,
    probe: async () => { calls.count += 1; return { runtime: current, versionOutput: "codex-cli 0.153.4", schemaFiles: await schemaFiles() }; }
  };
  const input = discoveryInput(fixture, probe);
  await discoverCodex(input);
  current = { ...baseRuntime, imageId: `sha256:${"b".repeat(64)}` };
  await discoverCodex(input);
  expect(calls.count).toBe(2);
});

test("rejects below-minimum and malformed versions while retaining bounded diagnostics", async () => {
  const below = await nativeFixture();
  const belowProbe = probeFixture({ version: "0.144.9" });
  const belowInput = discoveryInput(below, belowProbe.probe);
  const belowResult = await discoverCodex(belowInput);
  expect(belowResult.compatibility.diagnostic).toBe("CODEX_VERSION_BELOW_MINIMUM");
  expect(belowResult.compatibility.transport).toBe("incompatible");
  expect(belowResult.profileAuthority.experimentalSchemaFingerprint).toBeNull();
  const belowCached = await discoverCodex(belowInput);
  expect(belowCached.compatibility.transport).toBe("incompatible");

  const malformed = await nativeFixture();
  const malformedProbe: CodexProbeRuntime = {
    inspect: async () => baseRuntime,
    probe: async () => ({ runtime: baseRuntime, versionOutput: "codex-cli unavailable", schemaFiles: await schemaFiles() })
  };
  const malformedResult = await discoverCodex(discoveryInput(malformed, malformedProbe));
  expect(malformedResult.compatibility.diagnostic).toBe("CODEX_VERSION_UNREADABLE");
  expect(JSON.stringify(malformedResult.compatibility)).not.toContain("codex-cli unavailable");
});

test("single-flights concurrent compatibility discovery for the exact closure", async () => {
  const fixture = await nativeFixture();
  const probeFixtureValue = probeFixture({ delayMs: 30 });
  const input = discoveryInput(fixture, probeFixtureValue.probe);
  await Promise.all([discoverCodex(input), discoverCodex(input)]);
  expect(probeFixtureValue.calls.count).toBe(1);
});
