import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { nativeCodexHistoryPageSchema, uuidV7Schema, type NativeCodexHistoryPage } from "@devspace/contracts";
import { redactSensitiveText } from "@devspace/diagnostics";
import { resolveCodexNativeRollout } from "./harness-codex-discovery.js";

const ROLLOUT_MAX_BYTES = 4 * 1024 * 1024;
const META_MAX_BYTES = 64 * 1024;
const PAGE_SIZE = 20;
const MAX_MESSAGES = 2_048;
const MAX_ROLLOUT_RECORDS = 8_192;
const MAX_MESSAGE_BYTES = 32_768;
const MAX_RECORD_BYTES = 1024 * 1024;
const CURSOR_MAX_BYTES = 2_048;
const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const HISTORY_RECORD_TYPES = new Set([
  "session_meta", "event_msg", "response_item", "turn_context", "token_usage_record", "compacted", "retained_context"
]);
const HISTORY_RESPONSE_ITEM_TYPES = new Set([
  "message", "function_call", "function_call_output", "reasoning", "web_search_call", "computer_call",
  "local_shell_call", "mcp_tool_call", "custom_tool_call", "image_generation_call", "code_interpreter_call",
  "apply_patch_call", "ghost_snapshot", "compaction"
]);
const HISTORY_EVENT_TYPES = new Set([
  "user_message", "task_started", "task_complete", "turn_started", "turn_complete", "turn_aborted",
  "agent_message", "agent_message_delta", "agent_reasoning", "agent_reasoning_delta", "item_started",
  "item_completed", "token_count", "error", "warning", "context_compacted", "model_rerouted",
  "thread_name_updated", "thread_goal_updated", "thread_goal_update", "entered_review_mode", "exited_review_mode",
  "turn_diff", "patch_apply_begin", "patch_apply_end", "exec_command_begin", "exec_command_end",
  "mcp_tool_call_begin", "mcp_tool_call_end", "web_search_begin", "web_search_end", "view_image_tool_call",
  "undo_started", "undo_completed", "background_event", "js_repl_call", "js_repl_output", "dynamic_tool_call",
  "collab_tool_call_begin", "collab_tool_call_end", "reasoning_summary_text_delta", "reasoning_summary_part_added",
  "reasoning_summary_part_updated", "raw_response_item", "raw_response_completed", "session_configured",
  "deprecation_notice", "hook_started", "hook_completed", "hook_failed", "hook_skipped", "hook_cancelled"
]);

type HistoryMessage = NativeCodexHistoryPage["messages"][number];
type Cursor = {
  readonly v: 1; readonly actor: string; readonly project: string; readonly session: string; readonly workspace: string; readonly generation: number;
  readonly source: "live" | "settled"; readonly size: number; readonly start: number;
  readonly digest: string; readonly before: number; readonly truncated: boolean;
};
export class CodexHistoryError extends Error {
  constructor(readonly code: "HISTORY_UNAVAILABLE" | "HISTORY_AMBIGUOUS" | "HISTORY_CHANGED" | "HISTORY_CURSOR_INVALID") {
    super(code);
  }
}

function encodeCursor(cursor: Cursor, secret: Buffer): string {
  const payload = Buffer.from(JSON.stringify(cursor)).toString("base64url");
  const signature = createHmac("sha256", secret).update(payload).digest("base64url");
  const result = `${payload}.${signature}`;
  if (Buffer.byteLength(result) > CURSOR_MAX_BYTES) throw new CodexHistoryError("HISTORY_UNAVAILABLE");
  return result;
}

function decodeCursor(value: string, secret: Buffer): Cursor {
  if (Buffer.byteLength(value) > CURSOR_MAX_BYTES) throw new CodexHistoryError("HISTORY_CURSOR_INVALID");
  const [payload, signature, extra] = value.split(".");
  if (payload === undefined || signature === undefined || extra !== undefined) throw new CodexHistoryError("HISTORY_CURSOR_INVALID");
  const expected = createHmac("sha256", secret).update(payload).digest();
  let received: Buffer;
  try { received = Buffer.from(signature, "base64url"); } catch { throw new CodexHistoryError("HISTORY_CURSOR_INVALID"); }
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) throw new CodexHistoryError("HISTORY_CURSOR_INVALID");
  let valueParsed: unknown;
  try { valueParsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")); }
  catch { throw new CodexHistoryError("HISTORY_CURSOR_INVALID"); }
  if (valueParsed === null || typeof valueParsed !== "object" || Array.isArray(valueParsed)) throw new CodexHistoryError("HISTORY_CURSOR_INVALID");
  const item = valueParsed as Record<string, unknown>;
  if (item.v !== 1 || typeof item.session !== "string" || !uuidV7Schema.safeParse(item.session).success
    || typeof item.workspace !== "string" || !uuidV7Schema.safeParse(item.workspace).success
    || !Number.isSafeInteger(item.generation) || (item.generation as number) < 1
    || typeof item.project !== "string" || !uuidV7Schema.safeParse(item.project).success
    || typeof item.actor !== "string" || !/^[a-f0-9]{64}$/u.test(item.actor)
    || (item.source !== "live" && item.source !== "settled")
    || !Number.isSafeInteger(item.size) || (item.size as number) < 0
    || !Number.isSafeInteger(item.start) || (item.start as number) < 0
    || typeof item.digest !== "string" || !/^[a-f0-9]{64}$/u.test(item.digest)
    || !Number.isSafeInteger(item.before) || (item.before as number) < 0
    || typeof item.truncated !== "boolean") throw new CodexHistoryError("HISTORY_CURSOR_INVALID");
  return item as Cursor;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function decodeUtf8(bytes: Buffer): string {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new CodexHistoryError("HISTORY_UNAVAILABLE"); }
}

function safeHistoryText(value: string): string {
  const oscPattern = new RegExp(`${ESC}\\][^${BEL}]*${BEL}|${ESC}\\][\\s\\S]*?${ESC}\\\\`, "gu");
  const csiPattern = new RegExp(`${ESC}\\[[0-?]*[ -/]*[@-~]`, "gu");
  const redacted = redactSensitiveText(value)
    .replace(/\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})\b/gu, "[REDACTED]")
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gu, "[REDACTED]")
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gu, "[REDACTED PRIVATE KEY]")
    .replace(/\bhttps?:\/\/[^/\s:@]+:[^/\s@]+@/giu, "https://[credentials]@")
    .replace(/(?:^|[\s("'])\/(?:[\w.@+-]+(?:\/[\w.@+-]*)*)/gu, " [path redacted]")
    .replace(/(?:^|[\s("'])~\/[\w.@+-]+(?:\/[\w.@+-]+)*/gu, " [path redacted]")
    .replace(/(?:^|[\s("'])(?:\.\.\/|\.\/)+[\w.@+-]+(?:\/[\w.@+-]+)*/gu, " [path redacted]")
    .replace(/(?:^|[\s("'])[A-Za-z]:\\[^\s"'<>]*/gu, " [path redacted]")
    .replace(/(?:^|\s)file:\/\/[^\s"'<>]*/giu, " [path redacted]")
    .replace(oscPattern, "")
    .replace(csiPattern, "")
    .replace(/\p{Cc}/gu, (character) => character === "\n" || character === "\t" ? character : "");
  const text = redacted.trim();
  if (Buffer.byteLength(text, "utf8") > MAX_MESSAGE_BYTES) throw new CodexHistoryError("HISTORY_UNAVAILABLE");
  return text;
}

function textContent(payload: Record<string, unknown>, supportedTypes: ReadonlySet<string>): string | null {
  if (!Array.isArray(payload.content)) return null;
  const parts: string[] = [];
  for (const partValue of payload.content) {
    const part = asRecord(partValue);
    if (part === null || typeof part.type !== "string") throw new CodexHistoryError("HISTORY_UNAVAILABLE");
    if (!supportedTypes.has(part.type)) continue;
    if (typeof part.text !== "string") throw new CodexHistoryError("HISTORY_UNAVAILABLE");
    parts.push(part.text);
  }
  return parts.length === 0 ? null : parts.join("");
}

function parseRollout(bytes: Buffer, input: { readonly nativeSessionId: string; readonly fileOffset: number }): HistoryMessage[] {
  const text = decodeUtf8(bytes);
  const lines = text.split("\n");
  const messages: HistoryMessage[] = [];
  const startedTurns = new Set<string>();
  const completedTurns = new Set<string>();
  const seenClients = new Set<string>();
  const finalResponseItems = new Map<string, string>();
  const seenUserMessages = new Map<string, { readonly source: "event" | "response"; readonly index: number }>();
  let activeTurnId: string | null = null;
  let sourceIndex = 0;
  let recordCount = 0;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    const index = sourceIndex++;
    if (line.length === 0) continue;
    recordCount += 1;
    if (recordCount > MAX_ROLLOUT_RECORDS) throw new CodexHistoryError("HISTORY_UNAVAILABLE");
    if (Buffer.byteLength(line, "utf8") > MAX_RECORD_BYTES) throw new CodexHistoryError("HISTORY_UNAVAILABLE");
    let decoded: unknown;
    try { decoded = JSON.parse(line); } catch { throw new CodexHistoryError("HISTORY_UNAVAILABLE"); }
    const envelope = asRecord(decoded);
    if (envelope === null || typeof envelope.type !== "string" || !HISTORY_RECORD_TYPES.has(envelope.type)) {
      throw new CodexHistoryError("HISTORY_UNAVAILABLE");
    }
    if (envelope.type === "session_meta") {
      const meta = asRecord(envelope.payload);
      if (meta?.id !== input.nativeSessionId) throw new CodexHistoryError("HISTORY_CHANGED");
      continue;
    }
    const timestamp = typeof envelope.timestamp === "string" && envelope.timestamp.length <= 64
      && Number.isFinite(Date.parse(envelope.timestamp)) ? envelope.timestamp : null;
    const rolloutPayload = asRecord(envelope.payload);
    if (rolloutPayload === null) throw new CodexHistoryError("HISTORY_UNAVAILABLE");
    if (envelope.type === "response_item") {
      const item = rolloutPayload;
      if (typeof item.type !== "string" || !HISTORY_RESPONSE_ITEM_TYPES.has(item.type)) {
        throw new CodexHistoryError("HISTORY_UNAVAILABLE");
      }
      if (item.type === "message" && item.role === "user") {
        const userText = textContent(item, new Set(["input_text"]));
        if (userText !== null) {
          const safe = safeHistoryText(userText);
          const key = `${timestamp ?? ""}\0${safe}`;
          const duplicate = seenUserMessages.get(key);
          const isDuplicate = duplicate !== undefined && duplicate.source !== "response" && index - duplicate.index <= 3;
          if (safe.length > 0 && !isDuplicate) {
            seenUserMessages.set(key, { source: "response", index });
            messages.push({ id: `u-${input.fileOffset + index}`, role: "user", text: safe, timestamp });
          }
        }
      } else if (item.type === "message" && item.role === "assistant" && item.phase === "final_answer") {
        if (item.turn_id !== undefined && (typeof item.turn_id !== "string" || item.turn_id.length === 0 || item.turn_id.length > 256)) {
          throw new CodexHistoryError("HISTORY_UNAVAILABLE");
        }
        const turnId = typeof item.turn_id === "string" ? item.turn_id : activeTurnId;
        const finalText = textContent(item, new Set(["output_text"]));
        if (turnId !== null && turnId !== undefined && finalText !== null) {
          finalResponseItems.set(turnId, safeHistoryText(finalText));
        }
      }
      continue;
    }
    if (envelope.type !== "event_msg") continue;
    const payload = rolloutPayload;
    if (typeof payload.type !== "string" || !HISTORY_EVENT_TYPES.has(payload.type)) {
      throw new CodexHistoryError("HISTORY_UNAVAILABLE");
    }
    if (payload.type === "user_message" && typeof payload.message === "string") {
      const clientId = typeof payload.client_id === "string" && payload.client_id.length <= 256 ? payload.client_id : null;
      if (clientId !== null && seenClients.has(clientId)) continue;
      if (clientId !== null) seenClients.add(clientId);
      const safe = safeHistoryText(payload.message);
      const key = `${timestamp ?? ""}\0${safe}`;
      const duplicate = seenUserMessages.get(key);
      const isDuplicate = duplicate !== undefined && duplicate.source !== "event" && index - duplicate.index <= 3;
      if (safe.length > 0 && !isDuplicate) {
        seenUserMessages.set(key, { source: "event", index });
        messages.push({ id: `u-${input.fileOffset + index}`, role: "user", text: safe, timestamp });
      }
    } else if (payload.type === "task_started" || payload.type === "turn_started") {
      if (typeof payload.turn_id !== "string" || payload.turn_id.length === 0 || payload.turn_id.length > 256) {
        throw new CodexHistoryError("HISTORY_UNAVAILABLE");
      }
      activeTurnId = payload.turn_id;
      startedTurns.add(payload.turn_id);
    } else if (payload.type === "task_complete" || payload.type === "turn_complete") {
      if (typeof payload.turn_id !== "string" || payload.turn_id.length === 0 || payload.turn_id.length > 256) {
        throw new CodexHistoryError("HISTORY_UNAVAILABLE");
      }
      if (!startedTurns.has(payload.turn_id) && typeof payload.last_agent_message !== "string"
        && !finalResponseItems.has(payload.turn_id)) continue;
      if (completedTurns.has(payload.turn_id)) continue;
      completedTurns.add(payload.turn_id);
      if (payload.error === undefined || payload.error === null) {
        const completionText = typeof payload.last_agent_message === "string" ? safeHistoryText(payload.last_agent_message) : "";
        const finalText = completionText.length > 0 ? completionText : finalResponseItems.get(payload.turn_id) ?? "";
        if (finalText.length > 0) messages.push({ id: `a-${createHash("sha256").update(payload.turn_id).digest("hex").slice(0, 32)}`,
          role: "assistant", text: finalText, timestamp });
      }
      finalResponseItems.delete(payload.turn_id);
      if (activeTurnId === payload.turn_id) activeTurnId = null;
    }
    if (messages.length > MAX_MESSAGES) throw new CodexHistoryError("HISTORY_UNAVAILABLE");
  }
  return messages;
}

async function readSnapshot(filePath: string, expectedId: string, expectedSize?: number): Promise<{
  readonly bytes: Buffer; readonly size: number; readonly start: number; readonly digest: string; readonly truncated: boolean;
}> {
  let handle;
  try { handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch { throw new CodexHistoryError("HISTORY_UNAVAILABLE"); }
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size > 32n * 1024n * 1024n
      || (expectedSize !== undefined && before.size < BigInt(expectedSize))) throw new CodexHistoryError("HISTORY_UNAVAILABLE");
    const snapshotSize = expectedSize ?? Number(before.size);
    const start = Math.max(0, snapshotSize - ROLLOUT_MAX_BYTES);
    const size = snapshotSize - start;
    const fullMetaLength = Math.min(snapshotSize, META_MAX_BYTES + 1);
    const metaBuffer = Buffer.alloc(fullMetaLength);
    let metaRead = 0;
    while (metaRead < metaBuffer.length) {
      const result = await handle.read(metaBuffer, metaRead, metaBuffer.length - metaRead, metaRead);
      if (result.bytesRead === 0) throw new CodexHistoryError("HISTORY_CHANGED");
      metaRead += result.bytesRead;
    }
    const firstEnd = metaBuffer.indexOf(0x0a);
    if (firstEnd < 0 || firstEnd > META_MAX_BYTES) throw new CodexHistoryError("HISTORY_UNAVAILABLE");
    let meta: unknown;
    try { meta = JSON.parse(decodeUtf8(metaBuffer.subarray(0, firstEnd))); }
    catch { throw new CodexHistoryError("HISTORY_UNAVAILABLE"); }
    const metaEnvelope = asRecord(meta);
    const metaPayload = asRecord(metaEnvelope?.payload);
    if (metaEnvelope?.type !== "session_meta" || metaPayload?.id !== expectedId
      || metaPayload.cwd !== "/workspace" && metaPayload.cwd !== "/workspace/"
      || metaPayload.parent_thread_id !== undefined && metaPayload.parent_thread_id !== null) {
      throw new CodexHistoryError("HISTORY_CHANGED");
    }
    const bytes = Buffer.alloc(size);
    let read = 0;
    while (read < size) {
      const result = await handle.read(bytes, read, size - read, start + read);
      if (result.bytesRead === 0) throw new CodexHistoryError("HISTORY_CHANGED");
      read += result.bytesRead;
    }
    const metadataConfirm = Buffer.alloc(fullMetaLength);
    let metadataConfirmRead = 0;
    while (metadataConfirmRead < metadataConfirm.length) {
      const result = await handle.read(metadataConfirm, metadataConfirmRead, metadataConfirm.length - metadataConfirmRead, metadataConfirmRead);
      if (result.bytesRead === 0) throw new CodexHistoryError("HISTORY_CHANGED");
      metadataConfirmRead += result.bytesRead;
    }
    const confirmHash = createHash("sha256");
    const verifyBuffer = Buffer.alloc(64 * 1024);
    let verifyOffset = 0;
    while (verifyOffset < size) {
      const requested = Math.min(verifyBuffer.length, size - verifyOffset);
      const result = await handle.read(verifyBuffer, 0, requested, start + verifyOffset);
      if (result.bytesRead === 0) throw new CodexHistoryError("HISTORY_CHANGED");
      confirmHash.update(verifyBuffer.subarray(0, result.bytesRead));
      verifyOffset += result.bytesRead;
    }
    if (!metadataConfirm.equals(metaBuffer) || confirmHash.digest("hex") !== createHash("sha256").update(bytes).digest("hex")) {
      throw new CodexHistoryError("HISTORY_CHANGED");
    }
    const after = await handle.stat({ bigint: true });
    const pathStats = await lstat(filePath);
    if (before.dev !== after.dev || before.ino !== after.ino || before.dev !== BigInt(pathStats.dev)
      || before.ino !== BigInt(pathStats.ino) || !pathStats.isFile() || pathStats.isSymbolicLink()
      || await realpath(filePath) !== filePath || after.size < before.size
      || (after.size === before.size && (after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs))) {
      throw new CodexHistoryError("HISTORY_CHANGED");
    }
    const firstNewline = bytes.indexOf(0x0a);
    const lastNewline = bytes.lastIndexOf(0x0a);
    if (firstNewline < 0 || lastNewline < firstNewline) return {
      bytes: Buffer.alloc(0), size: snapshotSize, start, digest: createHash("sha256").update(bytes).digest("hex"), truncated: start > 0
    };
    const complete = bytes.subarray(firstNewline + 1, lastNewline + 1);
    return {
      bytes: complete, size: snapshotSize, start, digest: createHash("sha256").update(bytes).digest("hex"), truncated: start > 0
    };
  } finally { await handle.close(); }
}

export async function readNativeCodexHistory(input: {
  readonly actorIdentity: string; readonly projectId: string; readonly sessionId: string; readonly workspaceId: string; readonly processGeneration: number;
  readonly source: "live" | "settled"; readonly rolloutRoot: string; readonly nativeSessionId: string | null;
  readonly discoveryBaseline: readonly string[]; readonly cursor: string | null; readonly cursorSecret: Buffer;
}): Promise<NativeCodexHistoryPage> {
  const discovery = await resolveCodexNativeRollout(input.rolloutRoot, input.nativeSessionId === null
    ? { baselineIds: input.discoveryBaseline } : { expectedId: input.nativeSessionId });
  if (discovery.kind === "ambiguous") throw new CodexHistoryError("HISTORY_AMBIGUOUS");
  if (discovery.kind === "missing") return nativeCodexHistoryPageSchema.parse({
    messages: [], olderCursor: null, olderHistoryTruncated: false, snapshot: input.source, available: false
  });
  let cursor: Cursor | null = null;
  if (input.cursor !== null) {
    cursor = decodeCursor(input.cursor, input.cursorSecret);
    const actorDigest = createHash("sha256").update(input.actorIdentity).digest("hex");
    if (cursor.actor !== actorDigest || cursor.project !== input.projectId || cursor.session !== input.sessionId || cursor.workspace !== input.workspaceId
      || cursor.generation !== input.processGeneration || cursor.source !== input.source) {
      throw new CodexHistoryError("HISTORY_CURSOR_INVALID");
    }
  }
  const snapshot = await readSnapshot(discovery.filePath, discovery.nativeSessionId, cursor?.size);
  if (cursor !== null && (cursor.digest !== snapshot.digest || cursor.start !== snapshot.start
    || cursor.truncated !== snapshot.truncated)) throw new CodexHistoryError("HISTORY_CHANGED");
  const messages = parseRollout(snapshot.bytes, { nativeSessionId: discovery.nativeSessionId, fileOffset: snapshot.start });
  const before = cursor?.before ?? messages.length;
  if (before > messages.length) throw new CodexHistoryError("HISTORY_CURSOR_INVALID");
  const start = Math.max(0, before - PAGE_SIZE);
  const page = messages.slice(start, before);
  const olderCursor = start > 0 ? encodeCursor({
    v: 1, actor: createHash("sha256").update(input.actorIdentity).digest("hex"), project: input.projectId,
    session: input.sessionId, workspace: input.workspaceId, generation: input.processGeneration,
    source: input.source, size: snapshot.size, start: snapshot.start, digest: snapshot.digest,
    before: start, truncated: snapshot.truncated
  }, input.cursorSecret) : null;
  return nativeCodexHistoryPageSchema.parse({ messages: page, olderCursor,
    olderHistoryTruncated: snapshot.truncated, snapshot: input.source, available: true });
}
