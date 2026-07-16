import * as z from "zod";
import { uuidV7Schema, type UuidV7 } from "./primitives.js";

export const MAX_EVENT_SEQUENCE = 9_007_199_254_740_991 as const;
export const eventSequenceSchema = z.number().int().min(1).max(MAX_EVENT_SEQUENCE);
export const cursorSequenceSchema = z.number().int().min(0).max(MAX_EVENT_SEQUENCE);
export type EventSequence = z.infer<typeof eventSequenceSchema>;
export type CursorSequence = z.infer<typeof cursorSequenceSchema>;

export const eventCursorInvalidReasons = [
  "missing",
  "malformed",
  "unsupported_version",
  "invalid_agent_boot_id",
  "invalid_sequence",
  "sequence_out_of_range"
] as const;
export type EventCursorInvalidReason = (typeof eventCursorInvalidReasons)[number];
export type EventCursor = `v1.${UuidV7}.${number}`;
export interface ParsedEventCursor {
  readonly agentBootId: UuidV7;
  readonly sequence: CursorSequence;
}
export type ParseEventCursorResult =
  | { readonly ok: true; readonly value: ParsedEventCursor; readonly cursor: EventCursor }
  | { readonly ok: false; readonly reason: EventCursorInvalidReason };

export function parseEventCursor(input: string | null | undefined): ParseEventCursorResult {
  if (input === null || input === undefined) return { ok: false, reason: "missing" };
  const first = input.split(".", 1)[0] ?? "";
  if (/^v[0-9]+$/u.test(first) && first !== "v1") {
    return { ok: false, reason: "unsupported_version" };
  }
  const components = input.split(".");
  if (components.length !== 3 || components[0] !== "v1" || /\s/u.test(input)) {
    return { ok: false, reason: "malformed" };
  }
  const boot = uuidV7Schema.safeParse(components[1]);
  if (!boot.success) return { ok: false, reason: "invalid_agent_boot_id" };
  const sequenceText = components[2]!;
  if (!/^(?:0|[1-9][0-9]*)$/u.test(sequenceText)) {
    return { ok: false, reason: "invalid_sequence" };
  }
  const sequence = Number(sequenceText);
  if (!Number.isSafeInteger(sequence) || sequence > MAX_EVENT_SEQUENCE) {
    return { ok: false, reason: "sequence_out_of_range" };
  }
  return {
    ok: true,
    value: { agentBootId: boot.data, sequence },
    cursor: input as EventCursor
  };
}

export function formatEventCursor(agentBootId: UuidV7, sequence: CursorSequence): EventCursor {
  return `v1.${uuidV7Schema.parse(agentBootId)}.${cursorSequenceSchema.parse(sequence)}`;
}

export const eventCursorSchema = z.string().regex(
  /^v1\.[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(?:0|[1-9][0-9]*)$/u
).superRefine((value, context) => {
  const result = parseEventCursor(value);
  if (!result.ok) context.addIssue({ code: "custom", message: result.reason });
}).transform((value) => value as EventCursor);
