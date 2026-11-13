import { appendFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { readNativeCodexHistory } from "./harness-codex-history.js";

const devspaceSessionId = "018f1f34-7000-7000-8000-000000000201";
const workspaceId = "018f1f34-7000-7000-8000-000000000202";
const projectId = "018f1f34-7000-7000-8000-000000000203";
const nativeSessionId = "018f1f34-7000-7000-8000-000000000204";
const cursorSecret = Buffer.alloc(32, 7);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function rollout(lines: readonly unknown[], id = nativeSessionId): Promise<{ root: string; file: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "devspace-codex-history-"));
  roots.push(root);
  const directory = path.join(root, "sessions", "2026", "11", "13");
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, `rollout-2026-11-13T12-00-00-${id}.jsonl`);
  await writeFile(file, lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
  return { root, file };
}

function meta(id = nativeSessionId) {
  return { timestamp: "2026-11-13T12:00:00.000Z", type: "session_meta", payload: {
    id, cwd: "/workspace", parent_thread_id: null, model_provider: "private-provider-metadata"
  } };
}

function event(type: string, payload: Record<string, unknown>, timestamp = "2026-11-13T12:00:00.000Z") {
  return { timestamp, type, payload };
}

function history(input: {
  readonly root: string; readonly source?: "live" | "settled"; readonly nativeId?: string | null;
  readonly baseline?: readonly string[]; readonly cursor?: string | null; readonly session?: string;
  readonly workspace?: string; readonly project?: string; readonly actor?: string;
}) {
  return readNativeCodexHistory({
    actorIdentity: input.actor ?? "owner@example.test", projectId: input.project ?? projectId,
    sessionId: input.session ?? devspaceSessionId, workspaceId: input.workspace ?? workspaceId,
    processGeneration: 1, source: input.source ?? "live", rolloutRoot: input.root,
    nativeSessionId: input.nativeId === undefined ? null : input.nativeId,
    discoveryBaseline: input.baseline ?? [], cursor: input.cursor ?? null, cursorSecret
  });
}

function exchange(turnId: string, user: string, assistant: string) {
  return [
    event("event_msg", { type: "user_message", message: user, kind: "plain" }),
    event("event_msg", { type: "task_started", turn_id: turnId }),
    event("event_msg", { type: "task_complete", turn_id: turnId, last_agent_message: assistant })
  ];
}

test("projects only allowlisted user input and completed final answers from both Codex rollout layouts", async () => {
  const lines = [meta(), ...exchange("turn-1", "first real prompt", "first complete answer"),
    event("response_item", { type: "reasoning", encrypted_content: "hidden reasoning" }),
    event("response_item", { type: "function_call_output", output: "secret tool result" }),
    event("event_msg", { type: "token_count", info: { total_token_usage: { total_tokens: 999 } } }),
    event("event_msg", { type: "task_started", turn_id: "turn-2" }),
    event("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "second real prompt" }] }),
    event("response_item", { type: "message", role: "assistant", phase: "final_answer", turn_id: "turn-2",
      content: [{ type: "output_text", text: "second complete answer" }] }),
    event("event_msg", { type: "task_complete", turn_id: "turn-2", last_agent_message: "" }),
    event("response_item", { type: "message", role: "developer", content: [{ type: "input_text", text: "hidden developer instruction" }] })];
  const home = await rollout(lines);

  const page = await history({ root: home.root });

  expect(page.available).toBe(true);
  expect(page.messages.map(({ role, text }) => [role, text])).toEqual([
    ["user", "first real prompt"], ["assistant", "first complete answer"],
    ["user", "second real prompt"], ["assistant", "second complete answer"]
  ]);
  expect(JSON.stringify(page)).not.toMatch(/private-provider|hidden reasoning|secret tool|token_usage|developer instruction/u);
});

test("assistant response items remain hidden until a matching successful completion", async () => {
  const home = await rollout([meta(),
    event("event_msg", { type: "task_started", turn_id: "failed-turn" }),
    event("response_item", { type: "message", role: "assistant", phase: "final_answer", turn_id: "failed-turn",
      content: [{ type: "output_text", text: "must not show before completion" }] }),
    event("event_msg", { type: "task_complete", turn_id: "failed-turn", last_agent_message: null,
      error: { message: "provider failure" } }),
    event("event_msg", { type: "task_started", turn_id: "incomplete-turn" }),
    event("response_item", { type: "message", role: "assistant", phase: "final_answer", turn_id: "incomplete-turn",
      content: [{ type: "output_text", text: "still streaming" }] })]);

  const page = await history({ root: home.root });

  expect(page.messages).toEqual([]);
});

test("redacts credentials, absolute paths, and terminal control bytes from projected text", async () => {
  const home = await rollout([meta(), ...exchange("safe-turn", "token: sk-test-123 /workspace/private.txt /etc",
    "Answer\u001b[31m\n/home/owner/secret.txt\nsk-proj-abcdefghijk123 ~/private/key.txt ../secrets/token")]);

  const page = await history({ root: home.root });
  const serialized = JSON.stringify(page);

  expect(serialized).not.toContain("sk-test-123");
  expect(serialized).not.toContain("/workspace/private.txt");
  expect(serialized).not.toContain("/home/owner/secret.txt");
  expect(serialized).not.toContain("/etc");
  expect(serialized).not.toContain("~/private/key.txt");
  expect(serialized).not.toContain("../secrets/token");
  expect(serialized).not.toContain("sk-proj-abcdefghijk123");
  expect(serialized).not.toContain("\\u001b");
  expect(page.messages.map(({ text }) => text)).toEqual(expect.arrayContaining([
    expect.stringContaining("[path redacted]")
  ]));
});

test("fails closed rather than truncating an oversized user or assistant message", async () => {
  const home = await rollout([meta(), ...exchange("large-turn", "a".repeat(32_769), "answer")]);
  await expect(history({ root: home.root })).rejects.toMatchObject({ code: "HISTORY_UNAVAILABLE" });
});

test("fails closed for malformed and unsupported complete rollout records", async () => {
  const unknown = await rollout([meta(), { timestamp: "2026-11-13T12:00:00.000Z", type: "future_private_record", payload: { secret: "x" } }]);
  await expect(history({ root: unknown.root })).rejects.toMatchObject({ code: "HISTORY_UNAVAILABLE" });

  const malformed = await rollout([meta()]);
  await appendFile(malformed.file, "{malformed complete line}\n");
  await expect(history({ root: malformed.root })).rejects.toMatchObject({ code: "HISTORY_UNAVAILABLE" });
});

test("drops an actively written partial JSON line and returns only complete records", async () => {
  const home = await rollout([meta(), ...exchange("complete-turn", "written prompt", "written answer")]);
  await appendFile(home.file, "{\"timestamp\":\"2026-11-13T12:00:01.000Z\",\"type\":\"event_msg\",\"payload\":");

  const page = await history({ root: home.root });

  expect(page.messages.map(({ text }) => text)).toEqual(["written prompt", "written answer"]);
});

test("pages in deterministic rollout order and binds cursors to actor, project, workspace, and session", async () => {
  const lines: unknown[] = [meta()];
  for (let index = 0; index < 22; index += 1) lines.push(...exchange(`turn-${index}`, `user ${index}`, `assistant ${index}`));
  const home = await rollout(lines);

  const newest = await history({ root: home.root });
  expect(newest.messages.map(({ text }) => text)).toEqual(Array.from({ length: 20 }, (_, offset) => {
    const index = 12 + Math.floor(offset / 2);
    return offset % 2 === 0 ? `user ${index}` : `assistant ${index}`;
  }));
  expect(newest.olderCursor).not.toBeNull();
  const older = await history({ root: home.root, cursor: newest.olderCursor });
  expect(older.messages.map(({ text }) => text)).toEqual(Array.from({ length: 20 }, (_, offset) => {
    const index = 2 + Math.floor(offset / 2);
    return offset % 2 === 0 ? `user ${index}` : `assistant ${index}`;
  }));
  expect(older.olderCursor).not.toBeNull();
  const oldest = await history({ root: home.root, cursor: older.olderCursor });
  expect(oldest.messages.map(({ text }) => text)).toEqual(["user 0", "assistant 0", "user 1", "assistant 1"]);
  expect(oldest.olderCursor).toBeNull();

  await expect(history({ root: home.root, cursor: newest.olderCursor, session: "018f1f34-7000-7000-8000-000000000205" }))
    .rejects.toMatchObject({ code: "HISTORY_CURSOR_INVALID" });
  await expect(history({ root: home.root, cursor: newest.olderCursor, workspace: "018f1f34-7000-7000-8000-000000000206" }))
    .rejects.toMatchObject({ code: "HISTORY_CURSOR_INVALID" });
  await expect(history({ root: home.root, cursor: newest.olderCursor, project: "018f1f34-7000-7000-8000-000000000207" }))
    .rejects.toMatchObject({ code: "HISTORY_CURSOR_INVALID" });
  await expect(history({ root: home.root, cursor: newest.olderCursor, actor: "another-owner@example.test" }))
    .rejects.toMatchObject({ code: "HISTORY_CURSOR_INVALID" });
  await expect(history({ root: home.root, cursor: `${newest.olderCursor}x` }))
    .rejects.toMatchObject({ code: "HISTORY_CURSOR_INVALID" });
});

test("pins older pagination to a consistent append-only live snapshot", async () => {
  const lines: unknown[] = [meta()];
  for (let index = 0; index < 12; index += 1) lines.push(...exchange(`turn-${index}`, `prompt ${index}`, `answer ${index}`));
  const home = await rollout(lines);
  const newest = await history({ root: home.root });
  expect(newest.olderCursor).not.toBeNull();
  await appendFile(home.file, `${JSON.stringify(event("event_msg", { type: "user_message", message: "new prompt" }))}\n`);

  const older = await history({ root: home.root, cursor: newest.olderCursor });

  expect(older.messages.map(({ text }) => text)).toEqual(["prompt 0", "answer 0", "prompt 1", "answer 1"]);
});

test("rejects a same-size rollout rewrite after a paging cursor was issued", async () => {
  const lines: unknown[] = [meta()];
  for (let index = 0; index < 12; index += 1) lines.push(...exchange(`turn-${index}`, `prompt ${index}`, `answer ${index}`));
  const home = await rollout(lines);
  const newest = await history({ root: home.root });
  const before = await readFile(home.file, "utf8");
  expect(newest.olderCursor).not.toBeNull();
  await writeFile(home.file, before.replace("prompt 0", "pr0mpt 0"));

  await expect(history({ root: home.root, cursor: newest.olderCursor })).rejects.toMatchObject({ code: "HISTORY_CHANGED" });
});

test("rejects duplicate canonical ids, foreign cwd, and child-thread sources", async () => {
  const foreign = await rollout([meta(), ...exchange("turn", "wrong source", "wrong answer")]);
  const existing = await readFile(foreign.file, "utf8");
  await writeFile(foreign.file, existing.replace('"cwd":"/workspace"', '"cwd":"/etc"'));
  await expect(history({ root: foreign.root })).resolves.toMatchObject({ available: false, messages: [] });

  const duplicate = await rollout([meta(), ...exchange("turn", "same source", "same answer")]);
  const duplicateFile = path.join(duplicate.root, "sessions", "2026", "11", "13", "rollout-duplicate.jsonl");
  await writeFile(duplicateFile, [meta(), ...exchange("turn-2", "other source", "other answer")]
    .map((line) => JSON.stringify(line)).join("\n") + "\n");
  await expect(history({ root: duplicate.root })).rejects.toMatchObject({ code: "HISTORY_AMBIGUOUS" });

  const child = await rollout([meta(), event("event_msg", { type: "task_started", turn_id: "child" })]);
  const childText = await readFile(child.file, "utf8");
  await writeFile(child.file, childText.replace('"parent_thread_id":null', '"parent_thread_id":"018f1f34-7000-7000-8000-000000000208"'));
  await expect(history({ root: child.root })).resolves.toMatchObject({ available: false, messages: [] });
});

test("does not open a symlinked rollout file", async () => {
  const home = await rollout([meta(), ...exchange("turn", "prompt", "answer")]);
  const target = path.join(home.root, "outside-rollout.jsonl");
  await rm(home.file);
  await writeFile(target, [meta(), ...exchange("turn", "prompt", "answer")]
    .map((line) => JSON.stringify(line)).join("\n") + "\n");
  await symlink(target, home.file);

  await expect(history({ root: home.root })).resolves.toMatchObject({ available: false, messages: [] });
});
