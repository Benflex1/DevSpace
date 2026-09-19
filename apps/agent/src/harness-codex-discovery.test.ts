import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { discoverCodexNativeSessionId } from "./harness-codex-discovery.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function writeCodexSession(home: string, input: { id: string; cwd: string; mtime: number }): Promise<void> {
  const dir = path.join(home, "sessions");
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${input.id}.jsonl`);
  await writeFile(file, `${JSON.stringify({ id: input.id, cwd: input.cwd })}\n`);
  const at = new Date(1_700_000_000_000 + input.mtime * 1000);
  await utimes(file, at, at);
}

test("discovers the newest workspace session id from CODEX_HOME/sessions", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "devspace-codex-discover-"));
  roots.push(home);
  await writeCodexSession(home, { id: "old", cwd: "/workspace", mtime: 1 });
  await writeCodexSession(home, { id: "new", cwd: "/workspace", mtime: 2 });
  await writeCodexSession(home, { id: "other-project", cwd: "/elsewhere", mtime: 3 });
  expect(await discoverCodexNativeSessionId(home)).toBe("new");
});

test("returns null rather than inventing an id", async () => {
  const emptyHome = await mkdtemp(path.join(tmpdir(), "devspace-codex-empty-"));
  roots.push(emptyHome);
  expect(await discoverCodexNativeSessionId(emptyHome)).toBeNull();
});
