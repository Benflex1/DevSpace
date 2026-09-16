import { readdir } from "node:fs/promises";
import path from "node:path";
import { uuidV7Schema } from "@devspace/contracts";
import { identitiesEqual, lstatIdentity, type FileIdentity } from "../private-state.js";
import type { CodexNativeHomeBinding } from "./native-home.js";

const PROVIDER_STATE_ROOTS = ["sessions", "archived_sessions"] as const;
const MAX_DIRECTORY_DEPTH = 6;
const MAX_PROVIDER_STATE_FILES = 4_096;
const ROLLOUT_NAME = /^rollout-[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}-[0-9]{2}-[0-9]{2}-([0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})(?:_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})?\.jsonl(?:\.zst)?$/iu;

export interface NativeSessionProvenance {
  readonly nativeSessionId: string;
  readonly homeIdentity: FileIdentity;
  readonly providerStateIdentity: FileIdentity;
  readonly observedAt: string;
}

export interface NativeSessionSnapshot {
  readonly homeIdentity: FileIdentity;
  readonly providerStateIdentities: ReadonlyMap<string, FileIdentity>;
}

function assertHomeIdentity(home: CodexNativeHomeBinding): Promise<{ readonly identity: FileIdentity }> {
  return (async () => {
    const observed = await lstatIdentity(home.homePath);
    if (observed === null || !observed.stats.isDirectory() || observed.stats.isSymbolicLink()
      || !identitiesEqual(observed.identity, home.identity)) {
      throw new Error("codex-session-home-identity");
    }
    return { identity: observed.identity };
  })();
}

function sessionIdFromRelativePath(relativePath: string): string | null {
  const parts = relativePath.split("/");
  if (parts.length !== 5 || (parts[0] !== "sessions" && parts[0] !== "archived_sessions")
    || !/^\d{4}$/u.test(parts[1] ?? "") || !/^\d{2}$/u.test(parts[2] ?? "") || !/^\d{2}$/u.test(parts[3] ?? "")) {
    return null;
  }
  const match = ROLLOUT_NAME.exec(parts[4] ?? "");
  const sessionId = match?.[1];
  return sessionId !== undefined && uuidV7Schema.safeParse(sessionId).success ? sessionId : null;
}

async function scanDirectory(input: {
  readonly homePath: string;
  readonly relativeDirectory: string;
  readonly depth: number;
  readonly result: Map<string, FileIdentity>;
}): Promise<void> {
  if (input.depth > MAX_DIRECTORY_DEPTH) throw new Error("codex-session-state-depth");
  const directory = path.resolve(input.homePath, input.relativeDirectory);
  const observedDirectory = await lstatIdentity(directory);
  if (observedDirectory === null) return;
  if (!observedDirectory.stats.isDirectory() || observedDirectory.stats.isSymbolicLink()) {
    throw new Error("codex-session-state-directory");
  }
  let children;
  try {
    children = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new Error("codex-session-state-read", { cause: error });
  }
  for (const child of children.sort((left, right) => left.name.localeCompare(right.name))) {
    if (child.name === "." || child.name === ".." || child.name.includes("\0")) {
      throw new Error("codex-session-state-name");
    }
    const relativePath = path.posix.join(input.relativeDirectory.replaceAll(path.sep, "/"), child.name);
    const childPath = path.resolve(input.homePath, relativePath);
    const observed = await lstatIdentity(childPath);
    if (observed === null) continue;
    if (child.isDirectory()) {
      await scanDirectory({ ...input, relativeDirectory: relativePath, depth: input.depth + 1 });
      continue;
    }
    if (child.isSymbolicLink() || !observed.stats.isFile()) throw new Error("codex-session-state-file");
    if (sessionIdFromRelativePath(relativePath) === null) continue;
    if (relativePath.endsWith(".jsonl.zst")) {
      const plainPath = relativePath.slice(0, -4);
      const plain = await lstatIdentity(path.resolve(input.homePath, plainPath));
      if (plain !== null) continue;
    }
    input.result.set(relativePath, observed.identity);
    if (input.result.size > MAX_PROVIDER_STATE_FILES) throw new Error("codex-session-state-limit");
  }
}

async function collectProviderState(home: CodexNativeHomeBinding): Promise<ReadonlyMap<string, FileIdentity>> {
  const result = new Map<string, FileIdentity>();
  for (const root of PROVIDER_STATE_ROOTS) {
    await scanDirectory({ homePath: home.homePath, relativeDirectory: root, depth: 0, result });
  }
  return result;
}

export async function snapshotNativeSessionState(input: {
  readonly home: CodexNativeHomeBinding;
}): Promise<NativeSessionSnapshot> {
  const home = await assertHomeIdentity(input.home);
  return { homeIdentity: home.identity, providerStateIdentities: await collectProviderState(input.home) };
}

function sessionIds(snapshot: NativeSessionSnapshot): ReadonlySet<string> {
  const result = new Set<string>();
  for (const relativePath of snapshot.providerStateIdentities.keys()) {
    const sessionId = sessionIdFromRelativePath(relativePath);
    if (sessionId !== null) result.add(sessionId);
  }
  return result;
}

export async function discoverNativeSession(input: {
  readonly before: NativeSessionSnapshot;
  readonly after: NativeSessionSnapshot;
  readonly home: CodexNativeHomeBinding;
}): Promise<NativeSessionProvenance> {
  const currentHome = await assertHomeIdentity(input.home);
  if (!identitiesEqual(input.before.homeIdentity, input.after.homeIdentity)
    || !identitiesEqual(input.before.homeIdentity, currentHome.identity)) {
    throw new Error("codex-session-home-identity");
  }
  const existingSessionIds = sessionIds(input.before);
  const candidates = [...input.after.providerStateIdentities.entries()]
    .filter(([relativePath]) => !input.before.providerStateIdentities.has(relativePath))
    .map(([relativePath, providerStateIdentity]) => ({
      relativePath,
      providerStateIdentity,
      nativeSessionId: sessionIdFromRelativePath(relativePath)
    }))
    .filter((candidate): candidate is typeof candidate & { readonly nativeSessionId: string } =>
      candidate.nativeSessionId !== null && !existingSessionIds.has(candidate.nativeSessionId));
  if (candidates.length !== 1) throw new Error("codex-session-candidate-count");
  const candidate = candidates[0]!;
  return {
    nativeSessionId: candidate.nativeSessionId,
    homeIdentity: currentHome.identity,
    providerStateIdentity: candidate.providerStateIdentity,
    observedAt: new Date().toISOString()
  };
}
