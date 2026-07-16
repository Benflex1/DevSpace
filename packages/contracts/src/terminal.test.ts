import { describe, expect, test } from "vitest";
import {
  TERMINAL_SUBPROTOCOL,
  decodeTerminalAgentFrame,
  decodeTerminalClientFrame,
  encodeTerminalAgentFrame,
  encodeTerminalClientFrame,
  terminalProtocolMetadata
} from "./index.js";

describe("terminal binary frames", () => {
  test("uses the fixed subprotocol and attachment metadata", () => {
    expect(TERMINAL_SUBPROTOCOL).toBe("devspace.terminal.v1");
    expect(terminalProtocolMetadata).toMatchObject({
      fragmentedMessagesAllowed: false,
      activeAttachmentsPerTerminal: 1,
      attachmentSlotReservedBeforeUpgrade: true,
      readyRequiredBeforeClientFrames: true
    });
  });

  test.each([
    [{ type: "input", data: Uint8Array.of(0x41, 0xff) }, [0x01, 0x41, 0xff]],
    [{ type: "resize", columns: 258, rows: 772 }, [0x02, 0x01, 0x02, 0x03, 0x04]],
    [{ type: "detach" }, [0x03]]
  ] as const)("encodes client frame %j to fixed vector", (frame, bytes) => {
    expect([...encodeTerminalClientFrame(frame)]).toEqual(bytes);
  });

  test.each([
    [{ type: "ready" }, [0x11]],
    [{ type: "output", data: Uint8Array.of(0x00, 0xfe) }, [0x12, 0x00, 0xfe]],
    [{ type: "exit", exitCode: null }, [0x13, 0x00]],
    [{ type: "exit", exitCode: -2 }, [0x13, 0x01, 0xff, 0xff, 0xff, 0xfe]],
    [{ type: "exit", exitCode: 0x01020304 }, [0x13, 0x01, 0x01, 0x02, 0x03, 0x04]]
  ] as const)("encodes agent frame %j to fixed vector", (frame, bytes) => {
    expect([...encodeTerminalAgentFrame(frame)]).toEqual(bytes);
  });

  test("decodes every accepted frame and preserves opaque bytes", () => {
    expect(decodeTerminalClientFrame(Uint8Array.of(0x01, 0xff))).toEqual({
      ok: true, frame: { type: "input", data: Uint8Array.of(0xff) }
    });
    expect(decodeTerminalClientFrame(Uint8Array.of(0x02, 0, 80, 0, 24))).toEqual({
      ok: true, frame: { type: "resize", columns: 80, rows: 24 }
    });
    expect(decodeTerminalClientFrame(Uint8Array.of(0x03))).toEqual({ ok: true, frame: { type: "detach" } });
    expect(decodeTerminalAgentFrame(Uint8Array.of(0x11))).toEqual({ ok: true, frame: { type: "ready" } });
    expect(decodeTerminalAgentFrame(Uint8Array.of(0x12, 0xff))).toEqual({
      ok: true, frame: { type: "output", data: Uint8Array.of(0xff) }
    });
    expect(decodeTerminalAgentFrame(Uint8Array.of(0x13, 0))).toEqual({
      ok: true, frame: { type: "exit", exitCode: null }
    });
    expect(decodeTerminalAgentFrame(Uint8Array.of(0x13, 0x01, 0xff, 0xff, 0xff, 0xfe))).toEqual({
      ok: true, frame: { type: "exit", exitCode: -2 }
    });
  });

  test("encoded and decoded payloads own copies instead of aliasing caller buffers", () => {
    const input = Uint8Array.of(0x41, 0x42);
    const encoded = encodeTerminalClientFrame({ type: "input", data: input });
    input[0] = 0xff;
    expect([...encoded]).toEqual([0x01, 0x41, 0x42]);

    const message = Uint8Array.of(0x12, 0x43, 0x44);
    const decoded = decodeTerminalAgentFrame(message);
    expect(decoded.ok).toBe(true);
    message[1] = 0xff;
    if (!decoded.ok || decoded.frame.type !== "output") throw new Error("Expected decoded output frame");
    expect([...decoded.frame.data]).toEqual([0x43, 0x44]);
  });

  test.each([
    [decodeTerminalClientFrame, [], "MALFORMED_LENGTH"],
    [decodeTerminalClientFrame, [0x01], "MALFORMED_LENGTH"],
    [decodeTerminalClientFrame, [0x02, 0, 0, 0, 24], "INVALID_RESIZE_DIMENSIONS"],
    [decodeTerminalClientFrame, [0x03, 0], "MALFORMED_LENGTH"],
    [decodeTerminalClientFrame, [0xff], "UNKNOWN_DISCRIMINATOR"],
    [decodeTerminalAgentFrame, [0x12], "MALFORMED_LENGTH"],
    [decodeTerminalAgentFrame, [0x13], "MALFORMED_LENGTH"],
    [decodeTerminalAgentFrame, [0x13, 0x02], "INVALID_EXIT_CODE"],
    [decodeTerminalAgentFrame, [0x13, 0x01, 0, 0], "MALFORMED_LENGTH"],
    [decodeTerminalAgentFrame, [0xff], "UNKNOWN_DISCRIMINATOR"]
  ] as const)("rejects malformed vector %j", (decode, bytes, error) => {
    expect(decode(Uint8Array.from(bytes))).toEqual({ ok: false, error });
  });

  test("enforces payload boundaries", () => {
    expect(() => encodeTerminalClientFrame({ type: "input", data: new Uint8Array(0) })).toThrow(RangeError);
    expect(() => encodeTerminalAgentFrame({ type: "output", data: new Uint8Array(65_537) })).toThrow(RangeError);
    expect(decodeTerminalClientFrame(new Uint8Array(65_538))).toEqual({ ok: false, error: "PAYLOAD_TOO_LARGE" });
    expect([...encodeTerminalClientFrame({ type: "input", data: new Uint8Array(65_536) })]).toHaveLength(65_537);
  });
});
