import { TERMINAL_SUBPROTOCOL } from "./primitives.js";

export const TERMINAL_MAX_PAYLOAD_BYTES = 65_536 as const;
export const TERMINAL_MAX_MESSAGE_BYTES = 65_537 as const;
export const TERMINAL_POST_EXIT_REPLAY_RETENTION_MS = 30_000 as const;
export const TERMINAL_PROTOCOL_ERROR_CLOSE_CODE = 1002 as const;
export const TERMINAL_NORMAL_CLOSE_CODE = 1000 as const;
export const TERMINAL_FAILURE_CLOSE_CODE = 1011 as const;
export const TERMINAL_ATTACHMENT_READY_VERSION = 2 as const;

export const terminalProtocolMetadata = Object.freeze({
  subprotocol: TERMINAL_SUBPROTOCOL,
  binaryOpcode: 0x2,
  fragmentedMessagesAllowed: false,
  activeAttachmentsPerTerminal: 1,
  attachmentSlotReservedBeforeUpgrade: true,
  readyRequiredBeforeClientFrames: true,
  attachmentReadyVersion: TERMINAL_ATTACHMENT_READY_VERSION,
  supportsTmuxHistoryControls: true,
  supportsTmuxSelectionCopy: true,
  detachClosesTerminalResource: false
});

export type TerminalClientFrame =
  | { readonly type: "input"; readonly data: Uint8Array }
  | { readonly type: "resize"; readonly columns: number; readonly rows: number }
  | { readonly type: "history" }
  | { readonly type: "live" }
  | { readonly type: "detach" };

export type TerminalAgentFrame =
  | { readonly type: "ready" }
  | { readonly type: "ready"; readonly version: typeof TERMINAL_ATTACHMENT_READY_VERSION; readonly attachmentId: string }
  | { readonly type: "output"; readonly data: Uint8Array }
  | { readonly type: "attachment-conflict" }
  | { readonly type: "exit"; readonly exitCode: number | null };

export type TerminalFrameDecodeErrorCode =
  | "UNKNOWN_DISCRIMINATOR"
  | "MALFORMED_LENGTH"
  | "PAYLOAD_TOO_LARGE"
  | "INVALID_RESIZE_DIMENSIONS"
  | "INVALID_EXIT_CODE"
  | "UNSUPPORTED_ATTACHMENT_VERSION"
  | "INVALID_ATTACHMENT_ID";

export type TerminalFrameDecodeResult<Frame> =
  | { readonly ok: true; readonly frame: Frame }
  | { readonly ok: false; readonly error: TerminalFrameDecodeErrorCode };

function decodeFailure(error: TerminalFrameDecodeErrorCode): TerminalFrameDecodeResult<never> {
  return Object.freeze({ ok: false, error });
}

function copyPayload(message: Uint8Array): Uint8Array {
  return message.slice(1);
}

export function decodeTerminalClientFrame(message: Uint8Array): TerminalFrameDecodeResult<TerminalClientFrame> {
  if (message.byteLength > TERMINAL_MAX_MESSAGE_BYTES) return decodeFailure("PAYLOAD_TOO_LARGE");
  if (message.byteLength === 0) return decodeFailure("MALFORMED_LENGTH");
  switch (message[0]) {
    case 0x01:
      if (message.byteLength < 2) return decodeFailure("MALFORMED_LENGTH");
      return { ok: true, frame: { type: "input", data: copyPayload(message) } };
    case 0x02: {
      if (message.byteLength !== 5) return decodeFailure("MALFORMED_LENGTH");
      const view = new DataView(message.buffer, message.byteOffset, message.byteLength);
      const columns = view.getUint16(1, false);
      const rows = view.getUint16(3, false);
      if (columns === 0 || rows === 0) return decodeFailure("INVALID_RESIZE_DIMENSIONS");
      return { ok: true, frame: { type: "resize", columns, rows } };
    }
    case 0x03:
      return message.byteLength === 1
        ? { ok: true, frame: { type: "detach" } }
        : decodeFailure("MALFORMED_LENGTH");
    case 0x04:
      return message.byteLength === 1
        ? { ok: true, frame: { type: "history" } }
        : decodeFailure("MALFORMED_LENGTH");
    case 0x05:
      return message.byteLength === 1
        ? { ok: true, frame: { type: "live" } }
        : decodeFailure("MALFORMED_LENGTH");
    default:
      return decodeFailure("UNKNOWN_DISCRIMINATOR");
  }
}

export function decodeTerminalAgentFrame(message: Uint8Array): TerminalFrameDecodeResult<TerminalAgentFrame> {
  if (message.byteLength > TERMINAL_MAX_MESSAGE_BYTES) return decodeFailure("PAYLOAD_TOO_LARGE");
  if (message.byteLength === 0) return decodeFailure("MALFORMED_LENGTH");
  switch (message[0]) {
    case 0x11:
      if (message.byteLength === 1) return { ok: true, frame: { type: "ready" } };
      if (message.byteLength !== 38) return decodeFailure("MALFORMED_LENGTH");
      if (message[1] !== TERMINAL_ATTACHMENT_READY_VERSION) return decodeFailure("UNSUPPORTED_ATTACHMENT_VERSION");
      {
        const attachmentId = new TextDecoder().decode(message.subarray(2));
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(attachmentId)) {
          return decodeFailure("INVALID_ATTACHMENT_ID");
        }
        return { ok: true, frame: { type: "ready", version: TERMINAL_ATTACHMENT_READY_VERSION, attachmentId } };
      }
    case 0x12:
      if (message.byteLength < 2) return decodeFailure("MALFORMED_LENGTH");
      return { ok: true, frame: { type: "output", data: copyPayload(message) } };
    case 0x13:
      if (message.byteLength === 1) return decodeFailure("MALFORMED_LENGTH");
      if (message.byteLength === 2 && message[1] === 0x00) {
        return { ok: true, frame: { type: "exit", exitCode: null } };
      }
      if (message.byteLength === 6 && message[1] === 0x01) {
        const view = new DataView(message.buffer, message.byteOffset, message.byteLength);
        return { ok: true, frame: { type: "exit", exitCode: view.getInt32(2, false) } };
      }
      return message[1] === 0x00 || message[1] === 0x01
        ? decodeFailure("MALFORMED_LENGTH")
        : decodeFailure("INVALID_EXIT_CODE");
    case 0x14:
      return message.byteLength === 1
        ? { ok: true, frame: { type: "attachment-conflict" } }
        : decodeFailure("MALFORMED_LENGTH");
    default:
      return decodeFailure("UNKNOWN_DISCRIMINATOR");
  }
}

function assertPayload(data: Uint8Array, label: string): void {
  if (data.byteLength < 1 || data.byteLength > TERMINAL_MAX_PAYLOAD_BYTES) {
    throw new RangeError(`${label} payload must contain 1 through ${TERMINAL_MAX_PAYLOAD_BYTES} bytes`);
  }
}

export function encodeTerminalClientFrame(frame: TerminalClientFrame): Uint8Array {
  if (frame.type === "detach") return Uint8Array.of(0x03);
  if (frame.type === "history") return Uint8Array.of(0x04);
  if (frame.type === "live") return Uint8Array.of(0x05);
  if (frame.type === "resize") {
    if (!Number.isInteger(frame.columns) || !Number.isInteger(frame.rows)
      || frame.columns < 1 || frame.columns > 65_535 || frame.rows < 1 || frame.rows > 65_535) {
      throw new RangeError("Terminal dimensions must be unsigned 16-bit non-zero integers");
    }
    const encoded = new Uint8Array(5);
    encoded[0] = 0x02;
    const view = new DataView(encoded.buffer);
    view.setUint16(1, frame.columns, false);
    view.setUint16(3, frame.rows, false);
    return encoded;
  }
  assertPayload(frame.data, "Input");
  const encoded = new Uint8Array(frame.data.byteLength + 1);
  encoded[0] = 0x01;
  encoded.set(frame.data, 1);
  return encoded;
}

export function encodeTerminalAgentFrame(frame: TerminalAgentFrame): Uint8Array {
  if (frame.type === "ready") {
    if ("attachmentId" in frame) {
      if (frame.version !== TERMINAL_ATTACHMENT_READY_VERSION
        || !/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(frame.attachmentId)) {
        throw new RangeError("Persistent terminal readiness requires a version 2 UUIDv7 attachment ID");
      }
      const encoded = new Uint8Array(38);
      encoded[0] = 0x11;
      encoded[1] = frame.version;
      encoded.set(new TextEncoder().encode(frame.attachmentId), 2);
      return encoded;
    }
    return Uint8Array.of(0x11);
  }
  if (frame.type === "attachment-conflict") return Uint8Array.of(0x14);
  if (frame.type === "output") {
    assertPayload(frame.data, "Output");
    const encoded = new Uint8Array(frame.data.byteLength + 1);
    encoded[0] = 0x12;
    encoded.set(frame.data, 1);
    return encoded;
  }
  if (frame.exitCode === null) return Uint8Array.of(0x13, 0x00);
  if (!Number.isInteger(frame.exitCode)
    || frame.exitCode < -2_147_483_648 || frame.exitCode > 2_147_483_647) {
    throw new RangeError("Exit code must be a signed 32-bit integer or null");
  }
  const encoded = new Uint8Array(6);
  encoded.set([0x13, 0x01]);
  new DataView(encoded.buffer).setInt32(2, frame.exitCode, false);
  return encoded;
}
