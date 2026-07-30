export {
  AI_SESSION_OUTPUT_MAX_BYTES,
  AI_TURN_ACTIVITY_HISTORY_MAX_BYTES,
  AI_TURN_ACTIVITY_HISTORY_MAX_ROWS,
  AI_TURN_OUTPUT_MAX_BYTES,
  decodeUtf8Prefix,
  truncateUtf8,
  utf8ByteLength
} from "../ai-bounds.js";
import { utf8ByteLength } from "../ai-bounds.js";

export const AI_SESSION_HISTORY_MAX_TURNS = 64;
export const AI_SESSION_EVENT_HISTORY_MAX_EVENTS = 2_048;
export const AI_SESSION_EVENT_HISTORY_MAX_BYTES = 16 * 1024 * 1024;
export const AI_SESSION_INTERACTION_HISTORY_MAX_ROWS = 256;
export const AI_SESSION_INTERACTION_HISTORY_MAX_BYTES = 4 * 1024 * 1024;
export const AI_INTERACTION_JSON_MAX_BYTES = 128 * 1024;
export const AI_SESSION_RESPONSE_MAX_BYTES = 8 * 1024 * 1024;
export const AI_EVENT_STREAM_RESPONSE_MAX_EVENTS = 512;
export const AI_EVENT_STREAM_RESPONSE_MAX_BYTES = 8 * 1024 * 1024;

export function isJsonWithinBytes(value: string, maxBytes: number): boolean {
  return utf8ByteLength(value) <= maxBytes;
}

export function parseBoundedJson(value: unknown, maxBytes: number): unknown {
  if (typeof value !== "string" || !isJsonWithinBytes(value, maxBytes)) return null;
  try { return JSON.parse(value) as unknown; } catch { return null; }
}

export function serializedBytes(value: unknown): number {
  return utf8ByteLength(JSON.stringify(value));
}
