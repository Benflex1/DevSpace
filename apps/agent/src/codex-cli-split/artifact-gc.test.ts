import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { parseCodexSplitRuntimeRecord, type CodexSplitRuntimeRecord } from "./runtime-record.js";
import { collectStaleCodexSplitArtifacts } from "./artifact-gc.js";

const workspaceId = "018f0f00-0000-7000-8000-000000000002";
const projectId = "018f0f00-0000-7000-8000-000000000001";
const revisionId = "018f0f00-0000-7000-8000-000000000003";
const currentDigest = "a".repeat(64);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
});

function record(closureDigest: string, executorId: string): CodexSplitRuntimeRecord {
  return parseCodexSplitRuntimeRecord({
    version: 2, projectId, workspaceId, revisionId, runtimePlanHash: `sha256-jcs-v1:${"b".repeat(64)}`, generation: 1,
    networks: {
      execution: { id: "execution-id", name: "execution-network", role: "execution", internal: true, defaultRoute: false },
      controlEgress: { id: "egress-id", name: "control-egress", role: "control-egress", internal: false, defaultRoute: true }
    },
    artifact: {
      packageVersion: "0.153.4", closureDigest, nativeCliPath: "/opt/devspace/codex/bin/codex",
      execServerCapability: "codex-0.153.4-exec-server", appServerCapability: "codex-0.153.4-app-server",
      codeModeHostCapability: "codex-0.153.4-code-mode-host"
    },
    executor: {
      id: executorId, imageId: `sha256:${"c".repeat(64)}`, imageReference: "node@sha256:" + "c".repeat(64), imageArchitecture: "amd64",
      worktreeIdentity: { device: "1", inode: "3" }, repositoryIdentity: { device: "1", inode: "4" }, administrationIdentity: { device: "1", inode: "5" },
      endpointUrl: "ws://codex-executor:4545", transportSecurity: "private-network-only"
    },
    execServer: { executorContainerId: executorId, execId: "server-id", endpointUrl: "ws://codex-executor:4545", serverPid: 11, transportSecurity: "private-network-only" },
    codeModeHost: { executorContainerId: executorId, execId: "code-mode-id", serverPid: 12, host: "codex-code-mode-host", port: 4546, url: "http://codex-code-mode-host:4546", listenUrl: "grpc://0.0.0.0:4546", networkId: "execution-id", transportSecurity: "private-network-only" },
    control: { id: "control-id", homeBinding: "owner-default", homeIdentity: { device: "1", inode: "2" }, appServer: { controlContainerId: "control-id", execId: "app-id", serverPid: 13, socketPath: "/codex-home/app-server-control/app-server-control.sock", socketIdentity: { device: "1", inode: "6" }, homeIdentity: { device: "1", inode: "2" }, codeModeHostUrl: "http://codex-code-mode-host:4546", transportSecurity: "private-network-only" } },
    sessions: []
  });
}

async function fixture(): Promise<string> {
  const root = await mkdtemp(path.join("/tmp", "devspace-codex-artifact-gc-"));
  roots.push(root);
  return root;
}

async function artifact(root: string, digest: string, timestamp: number, suffix: string): Promise<string> {
  const directory = path.join(root, `codex-${digest}-${timestamp}-${suffix}`);
  await mkdir(directory, { mode: 0o700 });
  await writeFile(path.join(directory, "manifest.json"), JSON.stringify({ closureDigest: digest, entrypointSha256: "d".repeat(64) }), { mode: 0o600 });
  return directory;
}

test("removes a bounded batch of stale owned closures while retaining current and referenced state", async () => {
  const root = await fixture();
  const oldTimestamp = 1_700_000_000_000;
  for (let index = 0; index < 51; index += 1) await artifact(root, "b".repeat(64), oldTimestamp + index, `dead${index.toString(16)}`);
  const activeDirectory = await artifact(root, "c".repeat(64), oldTimestamp, "active");
  const referencedDirectory = await artifact(root, "d".repeat(64), oldTimestamp, "record");
  const currentDirectory = await artifact(root, currentDigest, oldTimestamp, "current");

  const report = await collectStaleCodexSplitArtifacts({
    managedArtifactRoot: root, workspaceId, currentClosureDigest: currentDigest,
    activeRuntimeRecords: [record("d".repeat(64), "persisted-executor"), record("c".repeat(64), "active-executor")],
    activeOwnedContainerIds: ["active-executor"], nowMs: 1_800_000_000_000, maxAgeMs: 1_000
  });

  expect(report.removed).toBe(51);
  expect(await readdir(root)).toEqual([
    path.basename(activeDirectory), path.basename(currentDirectory), path.basename(referencedDirectory)
  ].sort());
});

test("retains foreign, malformed, symlinked, young, and ambiguous entries", async () => {
  const root = await fixture();
  const oldTimestamp = 1_700_000_000_000;
  const foreign = path.join(root, "codex-not-a-digest");
  await mkdir(foreign);
  const outside = await mkdtemp(path.join("/tmp", "devspace-codex-artifact-gc-outside-"));
  roots.push(outside);
  const symlinkName = path.join(root, `codex-${"e".repeat(64)}-${oldTimestamp}-symlink`);
  await symlink(outside, symlinkName);
  const young = await artifact(root, "f".repeat(64), 1_799_999_999_999, "young");
  const malformed = path.join(root, `codex-${"1".repeat(64)}-not-a-timestamp-bad`);
  await mkdir(malformed);

  const report = await collectStaleCodexSplitArtifacts({
    managedArtifactRoot: root, workspaceId, currentClosureDigest: currentDigest,
    activeRuntimeRecords: [], activeOwnedContainerIds: [], nowMs: 1_800_000_000_000, maxAgeMs: 1_000
  });

  expect(report.removed).toBe(0);
  expect(report.skipped).toBeGreaterThanOrEqual(4);
  await expect(readdir(root)).resolves.toEqual([
    path.basename(foreign), path.basename(malformed), path.basename(symlinkName), path.basename(young)
  ].sort());
});

test("retains eligible artifacts when an active owned container has no matching persisted record", async () => {
  const root = await fixture();
  const stale = await artifact(root, "b".repeat(64), 1_700_000_000_000, "unknown");
  await collectStaleCodexSplitArtifacts({
    managedArtifactRoot: root, workspaceId, currentClosureDigest: currentDigest,
    activeRuntimeRecords: [], activeOwnedContainerIds: ["unknown-executor"], nowMs: 1_800_000_000_000, maxAgeMs: 1_000
  });
  await expect(readdir(root)).resolves.toContain(path.basename(stale));
});

test("rejects an artifact root outside the absolute managed scope", async () => {
  await expect(collectStaleCodexSplitArtifacts({
    managedArtifactRoot: "relative-artifacts", workspaceId, currentClosureDigest: currentDigest,
    activeRuntimeRecords: [], activeOwnedContainerIds: [], nowMs: 1_800_000_000_000, maxAgeMs: 1_000
  })).rejects.toThrow("codex-artifact-gc-root");
});
