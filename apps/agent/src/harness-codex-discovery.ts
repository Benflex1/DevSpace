import { constants } from "node:fs";
import { lstat, open, opendir } from "node:fs/promises";
import path from "node:path";
import { uuidV7Schema } from "@devspace/contracts";

const MAX_ROLLOUT_FILES = 4_096;
const MAX_HOME_ENTRIES = 16_384;
const MAX_SESSION_META_BYTES = 64 * 1024;

type CodexSessionMetadata = {
  id: string;
  cwd: string | null;
  parentThreadId: string | null;
  fileStem: string;
};

type DiscoveryOptions = {
  baselineIds?: readonly string[];
  expectedId?: string;
};

async function collectJsonl(root: string, into: string[], budget: { entries: number }): Promise<void> {
  let rootStats;
  try { rootStats = await lstat(root); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  // Harness home entries can be symlinks created inside the container. Never
  // follow one from the Agent host while searching for a native session id.
  if (!rootStats.isDirectory()) return;
  const directory = await opendir(root);
  for await (const entry of directory) {
    budget.entries += 1;
    if (budget.entries > MAX_HOME_ENTRIES) throw new Error("codex-session-discovery-entry-limit");
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) await collectJsonl(full, into, budget);
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      into.push(full);
      if (into.length > MAX_ROLLOUT_FILES) throw new Error("codex-session-discovery-rollout-limit");
    }
  }
}

async function readSessionMetadata(file: string): Promise<CodexSessionMetadata | null> {
  let handle;
  try { handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ELOOP") return null;
    throw error;
  }
  let bytes: Buffer;
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) return null;
    const buffer = Buffer.alloc(MAX_SESSION_META_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    bytes = buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }

  const text = bytes.toString("utf8");
  const lineEnd = text.indexOf("\n");
  if (lineEnd < 0 && bytes.length > MAX_SESSION_META_BYTES) return null;
  const first = (lineEnd < 0 ? text : text.slice(0, lineEnd)).trim();
  if (first.length === 0 || Buffer.byteLength(first) > MAX_SESSION_META_BYTES) return null;

  let parsed: unknown;
  try { parsed = JSON.parse(first); } catch { return null; }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const top = parsed as Record<string, unknown>;
  if (top.type !== "session_meta" || top.payload === null || typeof top.payload !== "object" || Array.isArray(top.payload)) return null;
  const payload = top.payload as Record<string, unknown>;
  if (typeof payload.id !== "string" || !uuidV7Schema.safeParse(payload.id).success) return null;
  return {
    id: payload.id,
    cwd: typeof payload.cwd === "string" ? payload.cwd : null,
    parentThreadId: payload.parent_thread_id === undefined || payload.parent_thread_id === null
      ? null
      : typeof payload.parent_thread_id === "string" ? payload.parent_thread_id : "<invalid>",
    fileStem: path.basename(file, ".jsonl")
  };
}

async function collectSessionMetadata(homePath: string): Promise<CodexSessionMetadata[]> {
  const files: string[] = [];
  await collectJsonl(path.join(homePath, "sessions"), files, { entries: 0 });
  const records: CodexSessionMetadata[] = [];
  for (const file of files) {
    const record = await readSessionMetadata(file);
    if (record !== null) records.push(record);
  }
  return records;
}

function isForegroundWorkspaceSession(item: CodexSessionMetadata): boolean {
  return (item.cwd === "/workspace" || item.cwd === "/workspace/") && item.parentThreadId === null;
}

/** Capture the existing canonical thread identities before a new foreground launch. */
export async function codexSessionIdBaseline(homePath: string): Promise<string[]> {
  const ids = new Set((await collectSessionMetadata(homePath)).map((item) => item.id));
  return [...ids].sort();
}

/** Returns an id only when the bounded evidence selects exactly one canonical rollout. */
export async function discoverCodexNativeSessionId(homePath: string, options: DiscoveryOptions = {}): Promise<string | null> {
  if (options.baselineIds !== undefined && options.expectedId !== undefined) return null;
  if (options.expectedId !== undefined && !uuidV7Schema.safeParse(options.expectedId).success) return null;
  if (options.baselineIds?.some((id) => !uuidV7Schema.safeParse(id).success)) return null;
  const baseline = options.baselineIds === undefined ? null : new Set(options.baselineIds);
  let candidates = (await collectSessionMetadata(homePath)).filter(isForegroundWorkspaceSession);
  if (options.expectedId !== undefined) candidates = candidates.filter((item) => item.id === options.expectedId);
  else if (baseline !== null) candidates = candidates.filter((item) => !baseline.has(item.id));
  return candidates.length === 1 ? candidates[0]!.id : null;
}

/** Repairs only the old filename-stem representation when one exact rollout proves its canonical id. */
export async function repairLegacyCodexFilenameId(homePath: string, legacyId: string): Promise<string | null> {
  const records = await collectSessionMetadata(homePath);
  const exact = records.filter((item) => item.fileStem === legacyId);
  if (exact.length !== 1) return null;
  const match = exact[0]!;
  const filenameId = match.fileStem.match(/^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-([0-9a-f-]{36})$/u)?.[1];
  if (filenameId !== match.id || !isForegroundWorkspaceSession(match)) return null;
  if (records.filter((item) => item.id === match.id).length !== 1) return null;
  return match.id;
}
