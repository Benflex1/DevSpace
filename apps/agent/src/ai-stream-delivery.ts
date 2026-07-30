import type { IncomingMessage, ServerResponse } from "node:http";
import {
  AI_EVENT_STREAM_FRAME_MAX_BYTES,
  type AiEventStreamFrame
} from "@devspace/contracts";

export const AI_STREAM_BACKPRESSURE_TIMEOUT_MS = 30_000;
export const AI_STREAM_LIVE_QUEUE_MAX_EVENTS = 32;
export const AI_STREAM_LIVE_QUEUE_MAX_BYTES =
  AI_EVENT_STREAM_FRAME_MAX_BYTES + 512 * 1024;

function serializeFrame(frame: AiEventStreamFrame): Buffer | null {
  try {
    const json = JSON.stringify(frame);
    if (Buffer.byteLength(json, "utf8") > AI_EVENT_STREAM_FRAME_MAX_BYTES) return null;
    return Buffer.from(`${json}\n`, "utf8");
  } catch {
    return null;
  }
}

export interface AiStreamDelivery {
  readonly closed: boolean;
  writeFrame(frame: AiEventStreamFrame): Promise<boolean>;
  enqueueLive(frame: AiEventStreamFrame): boolean;
  setUnsubscribe(unsubscribe: () => void): void;
  close(destroyResponse?: boolean): void;
}

export function createAiStreamDelivery(options: {
  readonly request: IncomingMessage;
  readonly response: ServerResponse;
  readonly backpressureTimeoutMs: number;
  readonly liveQueueMaxEvents: number;
  readonly liveQueueMaxBytes: number;
  readonly onClose: () => void;
}): AiStreamDelivery {
  const { request, response } = options;
  const queue: Buffer[] = [];
  const closeWaiters = new Set<() => void>();
  let queuedBytes = 0;
  let pumping = false;
  let closed = false;
  let unsubscribe: (() => void) | null = null;

  const onRequestClose = () => close(false);
  const onResponseClose = () => close(false);
  const onResponseError = () => close(false);

  request.once("close", onRequestClose);
  response.once("close", onResponseClose);
  response.once("error", onResponseError);

  function close(destroyResponse = true): void {
    if (closed) return;
    closed = true;
    request.off("close", onRequestClose);
    response.off("close", onResponseClose);
    response.off("error", onResponseError);
    for (const wake of closeWaiters) wake();
    closeWaiters.clear();
    queue.length = 0;
    queuedBytes = 0;
    const releaseSubscription = unsubscribe;
    unsubscribe = null;
    try { releaseSubscription?.(); } catch { /* subscriber cleanup cannot escape */ }
    options.onClose();
    if (destroyResponse && !response.destroyed) response.destroy();
  }

  async function waitForDrain(): Promise<boolean> {
    if (closed || response.destroyed) return false;
    return await new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (drained: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        response.off("drain", onDrain);
        closeWaiters.delete(onClosed);
        resolve(drained);
      };
      const onDrain = () => finish(true);
      const onClosed = () => finish(false);
      const timer = setTimeout(() => {
        finish(false);
        close();
      }, options.backpressureTimeoutMs);
      timer.unref();
      closeWaiters.add(onClosed);
      response.once("drain", onDrain);
      if (closed || response.destroyed) onClosed();
    });
  }

  async function writeSerialized(frame: Buffer): Promise<boolean> {
    if (closed || response.destroyed) return false;
    let accepted: boolean;
    try { accepted = response.write(frame); }
    catch { close(); return false; }
    if (accepted) return true;
    const drained = await waitForDrain();
    if (!drained) close();
    return drained && !closed && !response.destroyed;
  }

  async function writeFrame(frame: AiEventStreamFrame): Promise<boolean> {
    const serialized = serializeFrame(frame);
    if (serialized === null) {
      close();
      return false;
    }
    return await writeSerialized(serialized);
  }

  function startPump(): void {
    if (pumping || closed) return;
    pumping = true;
    (async () => {
      try {
        while (!closed) {
          const frame = queue.shift();
          if (frame === undefined) return;
          queuedBytes -= frame.length;
          if (!await writeSerialized(frame)) return;
        }
      } finally {
        pumping = false;
        if (!closed && queue.length > 0) startPump();
      }
    })().catch(() => close());
  }

  function enqueueLive(frame: AiEventStreamFrame): boolean {
    if (closed) return false;
    const serialized = serializeFrame(frame);
    if (serialized === null
      || queue.length + 1 > options.liveQueueMaxEvents
      || queuedBytes + serialized.length > options.liveQueueMaxBytes) {
      close();
      return false;
    }
    queue.push(serialized);
    queuedBytes += serialized.length;
    startPump();
    return true;
  }

  return {
    get closed() { return closed; },
    writeFrame,
    enqueueLive,
    setUnsubscribe(next) {
      if (unsubscribe !== null) {
        try { next(); } catch { /* duplicate subscription cleanup cannot escape */ }
        return;
      }
      if (closed) {
        try { next(); } catch { /* late subscription cleanup cannot escape */ }
      } else {
        let released = false;
        unsubscribe = () => {
          if (released) return;
          released = true;
          next();
        };
      }
    },
    close
  };
}
