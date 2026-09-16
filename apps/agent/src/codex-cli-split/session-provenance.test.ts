import { chmod, lstat, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { discoverNativeSession, snapshotNativeSessionState } from "./session-provenance.js";
import type { CodexNativeHomeBinding } from "./native-home.js";
import { lstatIdentity } from "../private-state.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
});

const oldId = "018f0f00-0000-7000-8000-000000000011";
const newId = "018f0f00-0000-7000-8000-000000000012";
const otherId = "018f0f00-0000-7000-8000-000000000013";

async function fixture(): Promise<{ readonly root: string; readonly home: CodexNativeHomeBinding }> {
  const root = await mkdtemp(path.join(tmpdir(), "devspace-session-provenance-"));
  roots.push(root);
  const sessions = path.join(root, "sessions", "2026", "09", "16");
  await mkdir(sessions, { recursive: true });
  await writeFile(path.join(sessions, `rollout-2026-09-16T10-00-00-${oldId}.jsonl`), "PRIVATE-OLD-PROMPT\n", { mode: 0o600 });
  const observed = await lstatIdentity(root);
  if (observed === null) throw new Error("fixture-home-missing");
  await chmod(root, 0o700);
  const stats = await lstat(root, { bigint: true });
  return {
    root,
    home: {
      accountBinding: "owner-default", homePath: root, mountTarget: "/codex-home", identity: observed.identity,
      ownerUid: Number(stats.uid), ownerGid: Number(stats.gid)
    }
  };
}

function rolloutPath(root: string, id: string, seconds: string): string {
  return path.join(root, "sessions", "2026", "09", "16", `rollout-2026-09-16T10-00-${seconds}-${id}.jsonl`);
}

test("discovers one new native rollout from path and file identity without reading content", async () => {
  const value = await fixture();
  const before = await snapshotNativeSessionState({ home: value.home });
  const created = rolloutPath(value.root, newId, "01");
  await writeFile(created, "PRIVATE-NEW-PROMPT\n{" + JSON.stringify({ secret: "PRIVATE-NEW-CONTENT" }) + "}\n", { mode: 0o600 });
  const after = await snapshotNativeSessionState({ home: value.home });
  const result = await discoverNativeSession({ before, after, home: value.home });
  expect(result.nativeSessionId).toBe(newId);
  expect(result.providerStateIdentity).toEqual((await lstatIdentity(created))!.identity);
  expect(result.homeIdentity).toEqual(value.home.identity);
  expect(JSON.stringify(result)).not.toContain("PRIVATE-NEW");
  expect(JSON.stringify(result)).not.toContain("rollout-2026");
});

test("rejects zero, multiple, and home-identity-drift candidates", async () => {
  const value = await fixture();
  const before = await snapshotNativeSessionState({ home: value.home });
  const unchanged = await snapshotNativeSessionState({ home: value.home });
  await expect(discoverNativeSession({ before, after: unchanged, home: value.home })).rejects.toThrow("session-candidate");

  await writeFile(rolloutPath(value.root, newId, "02"), "PRIVATE-A\n", { mode: 0o600 });
  await writeFile(rolloutPath(value.root, otherId, "03"), "PRIVATE-B\n", { mode: 0o600 });
  const multiple = await snapshotNativeSessionState({ home: value.home });
  await expect(discoverNativeSession({ before, after: multiple, home: value.home })).rejects.toThrow("session-candidate");

  const replacement = path.join(value.root, "replacement");
  await mkdir(replacement, { mode: 0o700 });
  const replacementIdentity = (await lstatIdentity(replacement))!;
  await expect(discoverNativeSession({ before, after: multiple, home: { ...value.home, identity: replacementIdentity.identity } }))
    .rejects.toThrow("session-home");
});

test("ignores compressed siblings and rejects symlinked provider-state directories", async () => {
  const value = await fixture();
  const before = await snapshotNativeSessionState({ home: value.home });
  const created = rolloutPath(value.root, newId, "04");
  await writeFile(`${created}.zst`, "PRIVATE-COMPRESSED\n", { mode: 0o600 });
  const compressed = await snapshotNativeSessionState({ home: value.home });
  const result = await discoverNativeSession({ before, after: compressed, home: value.home });
  expect(result.nativeSessionId).toBe(newId);
  expect(JSON.stringify(result)).not.toContain("PRIVATE-COMPRESSED");

  const outside = await mkdtemp(path.join(tmpdir(), "devspace-session-outside-"));
  roots.push(outside);
  const linkedRoot = path.join(value.root, "archived_sessions");
  await symlink(outside, linkedRoot);
  await expect(snapshotNativeSessionState({ home: value.home })).rejects.toThrow("session-state");
});
