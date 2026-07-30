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

export type RetainedHistoryProjection = {
  session: {
    lastSequence: number;
    historyStartSequence: number;
    historyTruncated: boolean;
  };
  events: Array<{ sequence: number }>;
};

export function normalizeRetainedHistory<T extends RetainedHistoryProjection>(value: T): T {
  const { lastSequence, historyStartSequence: originalHistoryStartSequence, historyTruncated } = value.session;
  if (!Number.isSafeInteger(lastSequence) || lastSequence < 0
    || !Number.isSafeInteger(originalHistoryStartSequence) || originalHistoryStartSequence < 1) {
    throw new Error("The retained AI history boundary is invalid.");
  }
  let normalizedHistoryStartSequence: number;
  if (value.events.length === 0) {
    normalizedHistoryStartSequence = lastSequence + 1;
    if (!Number.isSafeInteger(normalizedHistoryStartSequence)) throw new Error("The retained AI history boundary is invalid.");
  } else {
    const firstSequence = value.events[0]!.sequence;
    if (!Number.isSafeInteger(firstSequence) || firstSequence < 1 || firstSequence > lastSequence) {
      throw new Error("The retained AI event sequence is invalid.");
    }
    for (let index = 1; index < value.events.length; index += 1) {
      const previous = value.events[index - 1]!.sequence;
      const current = value.events[index]!.sequence;
      if (!Number.isSafeInteger(current) || current !== previous + 1) {
        throw new Error("The retained AI event sequence is not contiguous.");
      }
    }
    const finalSequence = value.events.at(-1)!.sequence;
    if (finalSequence !== lastSequence) throw new Error("The retained AI event suffix is not current.");
    normalizedHistoryStartSequence = firstSequence;
  }
  if (normalizedHistoryStartSequence < originalHistoryStartSequence) {
    throw new Error("The retained AI history boundary moved backwards.");
  }
  return {
    ...value,
    session: {
      ...value.session,
      historyStartSequence: normalizedHistoryStartSequence,
      historyTruncated: historyTruncated || normalizedHistoryStartSequence > originalHistoryStartSequence
    },
    events: value.events
  };
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
