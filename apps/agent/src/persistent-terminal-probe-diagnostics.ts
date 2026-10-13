import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { Duplex } from "node:stream";

export type ProbeProgressStatus = "started" | "completed" | "failed" | "timed_out" | "info";

export interface ProbeProgressEvent {
  readonly timestamp: string;
  readonly elapsedMs: number;
  readonly image: string;
  readonly checkpoint: string;
  readonly status: ProbeProgressStatus;
  readonly lastCompletedCheckpoint: string | null;
  readonly details?: Readonly<Record<string, unknown>>;
}

export class ProbeProgress {
  readonly events: ProbeProgressEvent[] = [];
  readonly startedAt = Date.now();
  lastCheckpoint: string | null = null;
  lastCompletedCheckpoint: string | null = null;

  constructor(readonly image: string, private readonly progressFile?: string) {
    if (progressFile !== undefined) mkdirSync(path.dirname(progressFile), { recursive: true, mode: 0o700 });
  }

  record(checkpoint: string, status: ProbeProgressStatus, details?: Readonly<Record<string, unknown>>): void {
    this.lastCheckpoint = checkpoint;
    if (status === "completed") this.lastCompletedCheckpoint = checkpoint;
    const event: ProbeProgressEvent = {
      timestamp: new Date().toISOString(),
      elapsedMs: Date.now() - this.startedAt,
      image: this.image,
      checkpoint,
      status,
      lastCompletedCheckpoint: this.lastCompletedCheckpoint,
      ...(details === undefined ? {} : { details })
    };
    this.events.push(event);
    if (this.progressFile !== undefined) appendFileSync(this.progressFile, `${JSON.stringify(event)}\n`, { mode: 0o600 });
  }

  async run<T>(
    checkpoint: string,
    timeoutMs: number,
    operation: () => Promise<T> | T,
    onTimeout?: () => void
  ): Promise<T> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error("rootless-tmux-probe-timeout-invalid");
    const operationStartedAt = Date.now();
    this.record(checkpoint, "started", { timeoutMs });
    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        let cleanupError: string | undefined;
        try { onTimeout?.(); }
        catch (error) { cleanupError = errorMessage(error); }
        this.record(checkpoint, "timed_out", {
          timeoutMs,
          durationMs: Date.now() - operationStartedAt,
          ...(cleanupError === undefined ? {} : { cleanupError })
        });
        reject(new Error(`rootless-tmux-probe-operation-timeout:${checkpoint}:${timeoutMs}ms`));
      }, timeoutMs);
    });
    try {
      const result = await Promise.race([Promise.resolve().then(operation), timeout]);
      this.record(checkpoint, "completed", { durationMs: Date.now() - operationStartedAt });
      return result;
    } catch (error) {
      if (!timedOut) this.record(checkpoint, "failed", {
        durationMs: Date.now() - operationStartedAt,
        error: errorMessage(error)
      });
      throw error instanceof Error ? error : new Error(`rootless-tmux-probe-operation-failed:${checkpoint}:${errorMessage(error)}`);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}

export function collectStreamUntilEof(
  stream: Duplex,
  checkpoint: string,
  timeoutMs: number,
  maxBytes = 4 * 1024 * 1024
): Promise<Buffer> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1
    || !Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new Error("rootless-tmux-probe-stream-limits-invalid");
  }
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let byteLength = 0;
    let settled = false;
    let terminationError: Error | null = null;
    let closeTimer: NodeJS.Timeout | undefined;

    const cleanup = () => {
      if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
      if (closeTimer !== undefined) clearTimeout(closeTimer);
      stream.off("data", onData);
      stream.off("end", onEnd);
      stream.off("error", onError);
      stream.off("close", onClose);
    };
    const finish = (error?: Error, output?: Buffer) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error !== undefined) reject(error);
      else resolve(output ?? Buffer.alloc(0));
    };
    const destroyAndFail = (error: Error) => {
      if (settled) return;
      terminationError = error;
      closeTimer = setTimeout(() => finish(error), 1_000);
      if (!stream.destroyed) stream.destroy();
      if (stream.closed) finish(error);
    };
    const onData = (value: unknown) => {
      if (settled || terminationError !== null) return;
      if (!Buffer.isBuffer(value) && !(value instanceof Uint8Array)) {
        destroyAndFail(new Error(`rootless-tmux-probe-stream-chunk-invalid:${checkpoint}`));
        return;
      }
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      byteLength += chunk.length;
      if (byteLength > maxBytes) {
        destroyAndFail(new Error(`rootless-tmux-probe-stream-limit-exceeded:${checkpoint}:${maxBytes}bytes`));
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => finish(undefined, Buffer.concat(chunks, byteLength));
    const onError = (error: Error) => {
      if (terminationError !== null) return;
      const streamError = new Error(`rootless-tmux-probe-stream-failed:${checkpoint}:${errorMessage(error)}`, { cause: error });
      if (!stream.destroyed) stream.destroy();
      finish(streamError);
    };
    const onClose = () => {
      if (terminationError !== null) finish(terminationError);
      else if (!settled) finish(new Error(`rootless-tmux-probe-stream-closed-before-eof:${checkpoint}`));
    };

    const deadlineTimer = setTimeout(() => {
      destroyAndFail(new Error(`rootless-tmux-probe-stream-timeout:${checkpoint}:${timeoutMs}ms`));
    }, timeoutMs);
    stream.on("data", onData);
    stream.once("end", onEnd);
    stream.once("error", onError);
    stream.once("close", onClose);
  });
}

export function errorMessage(error: unknown, causeDepth = 0): string {
  if (error instanceof Error) {
    const message = error.message.slice(0, 500);
    if (error.cause !== undefined && causeDepth < 3) {
      return `${message}:cause=${errorMessage(error.cause, causeDepth + 1)}`.slice(0, 1_000);
    }
    return message;
  }
  return String(error).slice(0, 1_000);
}
