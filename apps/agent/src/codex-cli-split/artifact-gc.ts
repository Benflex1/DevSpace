import { readdir, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { uuidV7Schema } from "@devspace/contracts";
import {
  assertContained,
  identitiesEqual,
  lstatIdentity,
  readRegularFileNoFollow,
  type FileIdentity
} from "../private-state.js";
import type { CodexSplitRuntimeRecord } from "./runtime-record.js";

const MAX_SCAN_ENTRIES = 512;
const MAX_MANIFEST_BYTES = 64 * 1024;
const ARTIFACT_DIRECTORY = /^codex-([0-9a-f]{64})-([0-9]{10,})-([0-9a-f]+)$/u;

export interface CodexSplitArtifactGcReport {
  readonly scanned: number;
  readonly retained: number;
  readonly removed: number;
  readonly skipped: number;
}

interface ArtifactCandidate {
  readonly path: string;
  readonly identity: FileIdentity;
  readonly closureDigest: string;
  readonly createdAtMs: number;
}

function assertDigest(value: string, reason: string): void {
  if (!/^[0-9a-f]{64}$/u.test(value)) throw new Error(reason);
}

async function ownedArtifactRoot(root: string): Promise<{ readonly path: string; readonly identity: FileIdentity } | null> {
  if (!path.isAbsolute(root) || root.includes("\0")) throw new Error("codex-artifact-gc-root");
  const absolute = path.resolve(root);
  const observed = await lstatIdentity(absolute);
  if (observed === null) return null;
  if (!observed.stats.isDirectory() || observed.stats.isSymbolicLink() || await realpath(absolute) !== absolute) {
    throw new Error("codex-artifact-gc-root");
  }
  return { path: absolute, identity: observed.identity };
}

function referencedClosureDigests(input: {
  readonly records: readonly CodexSplitRuntimeRecord[];
  readonly workspaceId: string;
  readonly activeContainerIds: readonly string[];
}): { readonly digests: ReadonlySet<string>; readonly ownershipAmbiguous: boolean } {
  const activeContainers = new Set(input.activeContainerIds);
  const scopedRecords = input.records.filter((record) => record.workspaceId === input.workspaceId);
  const result = new Set(input.records.map((record) => record.artifact.closureDigest));
  const knownActiveContainers = new Set(scopedRecords.map((record) => record.executor.id));
  for (const record of scopedRecords) {
    if (activeContainers.has(record.executor.id)) result.add(record.artifact.closureDigest);
  }
  return {
    digests: result,
    ownershipAmbiguous: [...activeContainers].some((containerId) => !knownActiveContainers.has(containerId))
  };
}

async function candidateFor(root: string, entryName: string): Promise<ArtifactCandidate | null> {
  const match = ARTIFACT_DIRECTORY.exec(entryName);
  if (match === null) return null;
  const createdAtMs = Number(match[2]);
  if (!Number.isSafeInteger(createdAtMs)) return null;
  const candidatePath = assertContained(root, path.join(root, entryName));
  const observed = await lstatIdentity(candidatePath);
  if (observed === null || !observed.stats.isDirectory() || observed.stats.isSymbolicLink()
    || Number(observed.stats.mode & 0o777n) !== 0o700 || await realpath(candidatePath) !== candidatePath) return null;
  let manifest;
  try {
    manifest = await readRegularFileNoFollow(path.join(candidatePath, "manifest.json"), MAX_MANIFEST_BYTES);
  } catch {
    return null;
  }
  let parsed: unknown;
  try { parsed = JSON.parse(manifest.bytes.toString("utf8")) as unknown; }
  catch { return null; }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const closureDigest = (parsed as { readonly closureDigest?: unknown }).closureDigest;
  const entrypointSha256 = (parsed as { readonly entrypointSha256?: unknown }).entrypointSha256;
  if (typeof closureDigest !== "string" || closureDigest !== match[1]
    || typeof entrypointSha256 !== "string" || !/^[0-9a-f]{64}$/u.test(entrypointSha256)) {
    return null;
  }
  return { path: candidatePath, identity: observed.identity, closureDigest, createdAtMs };
}

async function removeOwnedCandidate(input: {
  readonly root: { readonly path: string; readonly identity: FileIdentity };
  readonly candidate: ArtifactCandidate;
}): Promise<boolean> {
  const rootBefore = await lstatIdentity(input.root.path);
  const candidateBefore = await lstatIdentity(input.candidate.path);
  if (rootBefore === null || candidateBefore === null
    || !identitiesEqual(rootBefore.identity, input.root.identity)
    || !identitiesEqual(candidateBefore.identity, input.candidate.identity)
    || !candidateBefore.stats.isDirectory() || candidateBefore.stats.isSymbolicLink()) return false;
  try {
    await rm(input.candidate.path, { recursive: true, force: false });
  } catch {
    return false;
  }
  const rootAfter = await lstatIdentity(input.root.path);
  return rootAfter !== null && identitiesEqual(rootAfter.identity, input.root.identity);
}

export async function collectStaleCodexSplitArtifacts(input: {
  readonly managedArtifactRoot: string;
  readonly workspaceId: string;
  readonly currentClosureDigest: string;
  readonly activeRuntimeRecords: readonly CodexSplitRuntimeRecord[];
  readonly activeOwnedContainerIds: readonly string[];
  readonly nowMs: number;
  readonly maxAgeMs: number;
}): Promise<CodexSplitArtifactGcReport> {
  uuidV7Schema.parse(input.workspaceId);
  assertDigest(input.currentClosureDigest, "codex-artifact-gc-digest");
  if (!Number.isSafeInteger(input.nowMs) || !Number.isSafeInteger(input.maxAgeMs) || input.nowMs < 0 || input.maxAgeMs < 1) {
    throw new Error("codex-artifact-gc-time");
  }
  const root = await ownedArtifactRoot(input.managedArtifactRoot);
  if (root === null) return { scanned: 0, retained: 0, removed: 0, skipped: 0 };
  const references = referencedClosureDigests({
    records: input.activeRuntimeRecords,
    workspaceId: input.workspaceId,
    activeContainerIds: input.activeOwnedContainerIds
  });
  let entries;
  try { entries = await readdir(root.path, { withFileTypes: true }); }
  catch { return { scanned: 0, retained: 0, removed: 0, skipped: 1 }; }
  let scanned = 0;
  let retained = 0;
  let removed = 0;
  let skipped = 0;
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (scanned >= MAX_SCAN_ENTRIES) { skipped += 1; continue; }
    scanned += 1;
    const candidate = await candidateFor(root.path, entry.name);
    if (candidate === null) { skipped += 1; continue; }
    if (references.ownershipAmbiguous || candidate.closureDigest === input.currentClosureDigest || references.digests.has(candidate.closureDigest)
      || candidate.createdAtMs > input.nowMs || input.nowMs - candidate.createdAtMs < input.maxAgeMs) {
      retained += 1;
      continue;
    }
    if (await removeOwnedCandidate({ root, candidate })) removed += 1;
    else { retained += 1; skipped += 1; }
  }
  return { scanned, retained, removed, skipped };
}
