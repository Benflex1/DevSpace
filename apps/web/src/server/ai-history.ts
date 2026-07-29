import { TextDecoder, TextEncoder } from "node:util";

export const AI_SESSION_HISTORY_MAX_TURNS = 64;
export const AI_TURN_OUTPUT_MAX_BYTES = 2 * 1024 * 1024;
export const AI_SESSION_OUTPUT_MAX_BYTES = 8 * 1024 * 1024;
export const AI_SESSION_EVENT_HISTORY_MAX_EVENTS = 2_048;
export const AI_SESSION_EVENT_HISTORY_MAX_BYTES = 16 * 1024 * 1024;
export const AI_SESSION_INTERACTION_HISTORY_MAX_ROWS = 256;
export const AI_SESSION_INTERACTION_HISTORY_MAX_BYTES = 4 * 1024 * 1024;
export const AI_INTERACTION_JSON_MAX_BYTES = 128 * 1024;
export const AI_SESSION_RESPONSE_MAX_BYTES = 8 * 1024 * 1024;
export const AI_EVENT_STREAM_RESPONSE_MAX_EVENTS = 512;
export const AI_EVENT_STREAM_RESPONSE_MAX_BYTES = 8 * 1024 * 1024;

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

function utf8CharacterWidth(leadingByte: number): number {
  if (leadingByte <= 0x7f) return 1;
  if (leadingByte <= 0xdf) return 2;
  if (leadingByte <= 0xef) return 3;
  return 4;
}

export function truncateUtf8(value: string, maxBytes: number): { readonly value: string; readonly truncated: boolean } {
  const bytes = encoder.encode(value);
  if (bytes.byteLength <= maxBytes) return { value, truncated: false };
  let end = Math.max(0, maxBytes);
  while (end > 0 && (bytes[end - 1]! & 0xc0) === 0x80) end -= 1;
  if (end > 0) {
    const leadingIndex = end - 1;
    if (utf8CharacterWidth(bytes[leadingIndex]!) > end - leadingIndex) end = leadingIndex;
  }
  return { value: decoder.decode(bytes.subarray(0, end)), truncated: true };
}

export function decodeUtf8Prefix(value: Uint8Array, maxBytes: number): { readonly value: string; readonly truncated: boolean } {
  const bounded = value.byteLength > maxBytes;
  if (!bounded) {
    try { return { value: decoder.decode(value), truncated: false }; } catch { return { value: "", truncated: true }; }
  }
  let end = Math.max(0, maxBytes);
  while (end > 0 && (value[end - 1]! & 0xc0) === 0x80) end -= 1;
  if (end > 0) {
    const leadingIndex = end - 1;
    if (utf8CharacterWidth(value[leadingIndex]!) > end - leadingIndex) end = leadingIndex;
  }
  try { return { value: decoder.decode(value.subarray(0, end)), truncated: true }; } catch { return { value: "", truncated: true }; }
}

export function utf8ByteLength(value: string): number {
  return encoder.encode(value).byteLength;
}

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
