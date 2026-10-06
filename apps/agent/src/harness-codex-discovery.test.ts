import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { discoverCodexNativeSessionId } from "./harness-codex-discovery.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function newHome(prefix = "devspace-codex-discover-"): Promise<string> {
  const home = await mkdtemp(path.join(tmpdir(), prefix));
  roots.push(home);
  return home;
}

async function writeModernCodexSession(home: string, input: {
  id: string; cwd: string; timestamp: string; sessionId?: string; parentThreadId?: string | null;
}): Promise<string> {
  const [year, month, day] = input.timestamp.slice(0, 10).split("-");
  const fileTimestamp = input.timestamp.slice(0, 19).replaceAll(":", "-");
  const directory = path.join(home, "sessions", year!, month!, day!);
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, `rollout-${fileTimestamp}-${input.id}.jsonl`);
  await writeFile(file, `${JSON.stringify({
    timestamp: input.timestamp,
    type: "session_meta",
    payload: {
      session_id: input.sessionId ?? input.id,
      id: input.id,
      timestamp: input.timestamp,
      cwd: input.cwd,
      ...(input.parentThreadId === undefined ? {} : { parent_thread_id: input.parentThreadId })
    }
  })}\n`);
  return file;
}

test("uses canonical session_meta payload.id rather than payload.session_id or rollout filename", async () => {
  const home = await newHome();
  const id = "018f1f34-7000-7000-8000-000000000101";
  await writeModernCodexSession(home, {
    id, sessionId: "018f1f34-7000-7000-8000-000000000102", cwd: "/workspace", timestamp: "2026-10-01T14:38:06.144Z"
  });

  expect(await discoverCodexNativeSessionId(home)).toBe(id);
});

test("honors the nested workspace cwd and only accepts root foreground threads", async () => {
  const elsewhere = await newHome();
  const childThread = await newHome();
  await writeModernCodexSession(elsewhere, {
    id: "018f1f34-7000-7000-8000-000000000103", cwd: "/elsewhere", timestamp: "2026-10-01T14:38:06.144Z"
  });
  await writeModernCodexSession(childThread, {
    id: "018f1f34-7000-7000-8000-000000000104", cwd: "/workspace", parentThreadId: "018f1f34-7000-7000-8000-000000000105",
    timestamp: "2026-10-01T14:38:07.144Z"
  });

  expect(await discoverCodexNativeSessionId(elsewhere)).toBeNull();
  expect(await discoverCodexNativeSessionId(childThread)).toBeNull();
});

test("does not invent an id from a rollout filename without canonical session metadata", async () => {
  const home = await newHome();
  const directory = path.join(home, "sessions", "2026", "10", "01");
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "rollout-2026-10-01T14-38-06-018f1f34-7000-7000-8000-000000000106.jsonl"),
    `${JSON.stringify({ type: "event_msg", payload: {} })}\n`);

  expect(await discoverCodexNativeSessionId(home)).toBeNull();
});

test("does not use session_index.jsonl as a native-session candidate", async () => {
  const home = await newHome();
  await writeFile(path.join(home, "session_index.jsonl"), `${JSON.stringify({
    id: "018f1f34-7000-7000-8000-000000000107", thread_name: "private thread", updated_at: "2026-10-01T14:38:06.144Z"
  })}\n`);

  expect(await discoverCodexNativeSessionId(home)).toBeNull();
});

test("session_index cannot override the id in the actual canonical rollout", async () => {
  const home = await newHome();
  const rolloutId = "018f1f34-7000-7000-8000-000000000112";
  await writeModernCodexSession(home, {
    id: rolloutId, cwd: "/workspace", timestamp: "2026-10-01T14:38:06.144Z"
  });
  await writeFile(path.join(home, "session_index.jsonl"), `${JSON.stringify({
    id: "018f1f34-7000-7000-8000-000000000113", thread_name: "newer indexed thread", updated_at: "2099-01-01T00:00:00.000Z"
  })}\n`);

  expect(await discoverCodexNativeSessionId(home)).toBe(rolloutId);
});

test("fails closed for malformed metadata and non-UUID Codex ids", async () => {
  const malformed = await newHome();
  const malformedDirectory = path.join(malformed, "sessions", "2026", "10", "01");
  await mkdir(malformedDirectory, { recursive: true });
  await writeFile(path.join(malformedDirectory, "rollout-2026-10-01T14-38-06-018f1f34-7000-7000-8000-000000000108.jsonl"), "{bad json}\n");

  const nonUuid = await newHome();
  const directory = path.join(nonUuid, "sessions", "2026", "10", "01");
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "rollout-2026-10-01T14-38-06-not-a-native-id.jsonl"), `${JSON.stringify({
    type: "session_meta", payload: { id: "not-a-native-id", cwd: "/workspace" }
  })}\n`);

  expect(await discoverCodexNativeSessionId(malformed)).toBeNull();
  expect(await discoverCodexNativeSessionId(nonUuid)).toBeNull();
});

test("does not choose the newest when multiple canonical workspace sessions are candidates", async () => {
  const home = await newHome();
  await writeModernCodexSession(home, {
    id: "018f1f34-7000-7000-8000-000000000109", cwd: "/workspace", timestamp: "2026-10-01T14:38:06.144Z"
  });
  await writeModernCodexSession(home, {
    id: "018f1f34-7000-7000-8000-000000000110", cwd: "/workspace", timestamp: "2026-10-01T14:39:06.144Z"
  });

  expect(await discoverCodexNativeSessionId(home)).toBeNull();
});

test("does not follow symlinked sessions roots or rollout files", async () => {
  const external = await newHome("devspace-codex-external-");
  const externalFile = await writeModernCodexSession(external, {
    id: "018f1f34-7000-7000-8000-000000000111", cwd: "/workspace", timestamp: "2026-10-01T14:38:06.144Z"
  });
  const linkedRoot = await newHome("devspace-codex-linked-root-");
  await symlink(path.join(external, "sessions"), path.join(linkedRoot, "sessions"));
  const linkedFile = await newHome("devspace-codex-linked-file-");
  const fileDirectory = path.join(linkedFile, "sessions", "2026", "10", "01");
  await mkdir(fileDirectory, { recursive: true });
  await symlink(externalFile, path.join(fileDirectory, path.basename(externalFile)));

  expect(await discoverCodexNativeSessionId(linkedRoot)).toBeNull();
  expect(await discoverCodexNativeSessionId(linkedFile)).toBeNull();
});
