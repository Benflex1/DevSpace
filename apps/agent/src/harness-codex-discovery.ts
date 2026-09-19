import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { assertNativeSessionId } from "@devspace/contracts";

type Candidate = { id: string; cwd: string | null; mtimeMs: number };

async function collectJsonl(root: string, into: string[]): Promise<void> {
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) await collectJsonl(full, into);
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) into.push(full);
  }
}

function readFields(line: string): { id: string | null; cwd: string | null } {
  try {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    const idValue = parsed.id ?? parsed.session_id ?? parsed.sessionId;
    const cwdValue = parsed.cwd ?? parsed.cwd_path ?? parsed.cwdPath;
    return {
      id: typeof idValue === "string" ? idValue : null,
      cwd: typeof cwdValue === "string" ? cwdValue : null
    };
  } catch {
    return { id: null, cwd: null };
  }
}

export async function discoverCodexNativeSessionId(homePath: string): Promise<string | null> {
  const files: string[] = [];
  await collectJsonl(path.join(homePath, "sessions"), files);
  const index = path.join(homePath, "session_index.jsonl");
  try { await lstat(index); files.push(index); } catch { /* optional */ }
  const candidates: Candidate[] = [];
  for (const file of files) {
    let stats;
    try { stats = await lstat(file); }
    catch { continue; }
    if (!stats.isFile()) continue;
    const text = await readFile(file, "utf8");
    const first = text.split("\n").find((line) => line.trim().length > 0) ?? "";
    const fields = readFields(first);
    let id = fields.id;
    if (id === null) {
      const stem = path.basename(file, ".jsonl");
      if (/^[A-Za-z0-9._:-]+$/.test(stem) && !stem.startsWith("-")) id = stem;
    }
    if (id === null) continue;
    try { assertNativeSessionId(id); } catch { continue; }
    candidates.push({ id, cwd: fields.cwd, mtimeMs: stats.mtimeMs });
  }
  const workspace = candidates.filter((item) => item.cwd === null || item.cwd === "/workspace" || item.cwd === "/workspace/");
  const pool = workspace.length > 0 ? workspace : [];
  pool.sort((left, right) => right.mtimeMs - left.mtimeMs);
  return pool[0]?.id ?? null;
}
