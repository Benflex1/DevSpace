import type { Duplex } from "node:stream";

export const CODEX_DEFAULT_MAX_JSON_MESSAGE_BYTES = 1_114_112;
export const CODEX_DEFAULT_MAX_DOCKER_FRAME_PAYLOAD_BYTES = CODEX_DEFAULT_MAX_JSON_MESSAGE_BYTES + 8 * 1024;
export const CODEX_DEFAULT_MAX_DOCKER_PARTIAL_BUFFER_BYTES = 8 + CODEX_DEFAULT_MAX_DOCKER_FRAME_PAYLOAD_BYTES;

export interface CodexJsonlTransportOptions {
  readonly stream: Duplex;
  readonly onMessage: (message: Record<string, unknown>) => void;
  readonly onProtocolFailure: (error: Error) => void;
  readonly maxJsonMessageBytes?: number;
  readonly maxFramePayloadBytes?: number;
  readonly maxPartialBufferBytes?: number;
}

export interface CodexJsonlTransport {
  readonly failed: boolean;
  write(value: unknown): void;
  receiveDockerData(chunk: Buffer): void;
  finish(): void;
  destroy(): void;
}

export function dockerMultiplexedFrame(payload: unknown, streamType = 1): Buffer {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(`${JSON.stringify(payload)}\n`, "utf8");
  if (streamType !== 1 && streamType !== 2) throw new Error("unsupported-docker-stream");
  const header = Buffer.alloc(8);
  header[0] = streamType;
  header.writeUInt32BE(body.length, 4);
  return Buffer.concat([header, body]);
}

export function createCodexJsonlTransport(options: CodexJsonlTransportOptions): CodexJsonlTransport {
  const maxJsonMessageBytes = options.maxJsonMessageBytes ?? CODEX_DEFAULT_MAX_JSON_MESSAGE_BYTES;
  const maxFramePayloadBytes = options.maxFramePayloadBytes ?? CODEX_DEFAULT_MAX_DOCKER_FRAME_PAYLOAD_BYTES;
  const maxPartialBufferBytes = options.maxPartialBufferBytes ?? 8 + maxFramePayloadBytes;
  let failed = false;
  let dockerHeader = Buffer.alloc(0);
  let dockerPayload = Buffer.alloc(0);
  let dockerPayloadLength: number | null = null;
  let dockerStreamType: 1 | 2 | null = null;
  let jsonLine = "";
  let jsonLineBytes = 0;
  const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

  const fail = (cause: unknown): void => {
    if (failed) return;
    failed = true;
    options.onProtocolFailure(cause instanceof Error ? cause : new Error("codex-transport-protocol-failure"));
  };

  const appendDockerBytes = (kind: "header" | "payload", bytes: Uint8Array): void => {
    const retained = dockerHeader.length + dockerPayload.length + bytes.length;
    if (retained > maxPartialBufferBytes) throw new Error("docker-partial-buffer-too-large");
    if (kind === "header") {
      if (dockerHeader.length + bytes.length > 8) throw new Error("docker-header-overflow");
      dockerHeader = Buffer.concat([dockerHeader, bytes]);
    } else {
      if (dockerPayloadLength === null || dockerPayload.length + bytes.length > dockerPayloadLength) throw new Error("docker-payload-overflow");
      dockerPayload = Buffer.concat([dockerPayload, bytes]);
    }
  };

  const finishJsonLine = (): void => {
    const line = jsonLine.endsWith("\r") ? jsonLine.slice(0, -1) : jsonLine;
    jsonLine = "";
    jsonLineBytes = 0;
    if (line.length === 0) return;
    let parsed: unknown;
    try { parsed = JSON.parse(line) as unknown; } catch { throw new Error("codex-jsonl-invalid-json"); }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("codex-jsonl-message-not-object");
    options.onMessage(parsed as Record<string, unknown>);
  };

  const processDecodedText = (text: string): void => {
    if (text.includes("\u0000")) throw new Error("codex-jsonl-nul-byte");
    let offset = 0;
    while (offset < text.length && !failed) {
      const newline = text.indexOf("\n", offset);
      const end = newline < 0 ? text.length : newline;
      const fragment = text.slice(offset, end);
      const fragmentBytes = Buffer.byteLength(fragment, "utf8");
      if (jsonLineBytes + fragmentBytes > maxJsonMessageBytes) throw new Error("codex-jsonl-message-too-large");
      jsonLine += fragment;
      jsonLineBytes += fragmentBytes;
      if (newline < 0) return;
      finishJsonLine();
      offset = newline + 1;
    }
  };

  const finishDockerFrame = (): void => {
    const payload = dockerPayload;
    const streamType = dockerStreamType;
    dockerPayload = Buffer.alloc(0);
    dockerPayloadLength = null;
    dockerStreamType = null;
    if (streamType === 1 && payload.length > 0) {
      processDecodedText(utf8Decoder.decode(payload, { stream: true }));
    }
  };

  const transport: CodexJsonlTransport = {
    get failed() { return failed; },
    write(value) {
      if (failed || options.stream.destroyed) throw new Error("codex-provider-stream-unavailable");
      options.stream.write(`${JSON.stringify(value)}\n`);
    },
    receiveDockerData(chunk) {
      if (failed) return;
      try {
        if (!Buffer.isBuffer(chunk)) throw new Error("invalid-docker-chunk");
        let offset = 0;
        while (offset < chunk.length && !failed) {
          if (dockerPayloadLength === null) {
            const need = 8 - dockerHeader.length;
            const take = Math.min(need, chunk.length - offset);
            appendDockerBytes("header", chunk.subarray(offset, offset + take));
            offset += take;
            if (dockerHeader.length < 8) continue;
            if (dockerHeader[1] !== 0 || dockerHeader[2] !== 0 || dockerHeader[3] !== 0) throw new Error("invalid-docker-header");
            const streamType = dockerHeader[0];
            if (streamType !== 1 && streamType !== 2) throw new Error("unsupported-docker-stream");
            const size = dockerHeader.readUInt32BE(4);
            if (!Number.isSafeInteger(size) || size > maxFramePayloadBytes) throw new Error("docker-frame-too-large");
            dockerPayloadLength = size;
            dockerStreamType = streamType;
            dockerHeader = Buffer.alloc(0);
            dockerPayload = Buffer.alloc(0);
            if (size === 0) finishDockerFrame();
          } else {
            const need = dockerPayloadLength - dockerPayload.length;
            const take = Math.min(need, chunk.length - offset);
            appendDockerBytes("payload", chunk.subarray(offset, offset + take));
            offset += take;
            if (dockerPayload.length === dockerPayloadLength) finishDockerFrame();
          }
        }
      } catch (error) {
        fail(error);
      }
    },
    finish() {
      if (failed) return;
      try {
        processDecodedText(utf8Decoder.decode());
        if (dockerHeader.length !== 0 || dockerPayloadLength !== null || dockerPayload.length !== 0 || jsonLineBytes !== 0) {
          throw new Error("codex-partial-protocol");
        }
      } catch (error) {
        fail(error);
      }
    },
    destroy() {
      if (!options.stream.destroyed) options.stream.destroy();
    }
  };
  return transport;
}
