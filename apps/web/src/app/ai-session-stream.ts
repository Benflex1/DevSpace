export type BrowserAiEvent = {
  schemaVersion: "devspace.ai-event/v1";
  eventId: string;
  sessionId: string;
  turnId: string | null;
  sequence: number;
  observedAt: string;
  profile: { profileId: string; profileRevision: string; provider: string };
  processGeneration: number;
  eventType: string;
  payload: Record<string, unknown>;
};

type BrowserAiStreamFrame = BrowserAiEvent | { frameType: string; [key: string]: unknown };
export type BrowserAiStreamControl = { frameType: string; [key: string]: unknown };
export type BrowserAiStreamStatus = "connected" | "reconnecting" | "unavailable" | "failed";
export class BrowserAiStreamError extends Error {
  constructor(message: string, readonly kind: "unavailable" | "failed") {
    super(message);
    this.name = "BrowserAiStreamError";
  }
}
type ConsumeAiEventStreamOptions = {
  initialSequence: number;
  initialEventId?: string | null;
  sessionId?: string;
  signal: AbortSignal;
  open: (afterSequence: number, signal: AbortSignal) => Promise<Response>;
  apply: (event: BrowserAiEvent) => void | boolean;
  isTerminal: () => boolean;
  sleep?: (delayMs: number, signal: AbortSignal) => Promise<void>;
  onControl?: (control: BrowserAiStreamControl) => void;
  onStatus?: (status: BrowserAiStreamStatus) => void;
};

const RETRY_DELAYS_MS = [100, 200, 400, 800, 1_600, 3_000] as const;
const DEFAULT_UNAVAILABLE_MESSAGE = "The live AI connection is temporarily unavailable. Committed history is preserved.";
const DEFAULT_FAILED_MESSAGE = "The AI event stream ended unexpectedly. Committed history is preserved.";

export async function sleepWithAbort(delayMs: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const abort = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(signal.reason instanceof Error ? signal.reason : new DOMException("The stream was aborted.", "AbortError"));
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      resolve();
    }, delayMs);
    if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
  });
}

const defaultSleep = sleepWithAbort;

function parseFrame(line: string): BrowserAiStreamFrame | null {
  if (line === "") return null;
  const value: unknown = JSON.parse(line);
  if (value === null || typeof value !== "object") throw new Error("The AI event stream frame is invalid.");
  return value as BrowserAiStreamFrame;
}

function canonicalFrame(value: BrowserAiStreamFrame): BrowserAiEvent | null {
  if ("frameType" in value) {
    if (typeof value.frameType !== "string" || value.frameType === "") throw new Error("The AI event stream frame is invalid.");
    return null;
  }
  if (typeof value.schemaVersion !== "string" || typeof value.eventId !== "string" || value.eventId === ""
    || typeof value.sessionId !== "string" || value.sessionId === "" || typeof value.eventType !== "string" || value.eventType === ""
    || typeof value.observedAt !== "string" || !Number.isSafeInteger(value.sequence) || value.sequence <= 0
    || (value.turnId !== null && typeof value.turnId !== "string") || value.profile === null || typeof value.profile !== "object"
    || typeof value.profile.profileId !== "string" || typeof value.profile.profileRevision !== "string" || typeof value.profile.provider !== "string"
    || !Number.isSafeInteger(value.processGeneration) || value.processGeneration < 0 || value.payload === null || typeof value.payload !== "object") {
    throw new Error("The AI event stream frame identity is invalid.");
  }
  return value;
}

function boundedControlMessage(control: BrowserAiStreamControl, fallback: string): string {
  return typeof control.message === "string" && control.message.length > 0 && control.message.length <= 512
    ? control.message : fallback;
}

function streamOpenError(status: number): BrowserAiStreamError {
  return new BrowserAiStreamError(status === 503 ? DEFAULT_UNAVAILABLE_MESSAGE
    : status === 409 ? "The selected AI session needs to be reloaded before it can reconnect."
      : "The AI event stream could not be opened safely.", status === 503 ? "unavailable" : "failed");
}

async function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>, reason: unknown): Promise<void> {
  try { await reader.cancel(reason); } catch { /* the body may already be closed */ }
}

export async function consumeAiEventStream(options: ConsumeAiEventStreamOptions): Promise<void> {
  const sleep = options.sleep ?? defaultSleep;
  if (!Number.isSafeInteger(options.initialSequence) || options.initialSequence < 0) throw new Error("The AI event stream cursor is invalid.");
  let lastAppliedSequence = options.initialSequence;
  let lastAppliedEventId = options.initialEventId ?? null;
  let zeroProgressCloses = 0;
  let temporaryUnavailableCloses = 0;
  let lastUnavailableMessage = DEFAULT_UNAVAILABLE_MESSAGE;
  while (!options.signal.aborted && !options.isTerminal()) {
    let response: Response;
    try { response = await options.open(lastAppliedSequence, options.signal); }
    catch (error) { if (options.signal.aborted) return; throw error; }
    if (!response.ok || response.body === null) {
      try { await response.body?.cancel(); } catch { /* the response is already closed */ }
      if (response.status === 503) {
        lastUnavailableMessage = DEFAULT_UNAVAILABLE_MESSAGE;
        options.onStatus?.("unavailable");
        if (temporaryUnavailableCloses >= RETRY_DELAYS_MS.length) {
          throw new BrowserAiStreamError(lastUnavailableMessage, "unavailable");
        }
        const delay = RETRY_DELAYS_MS[Math.min(temporaryUnavailableCloses, RETRY_DELAYS_MS.length - 1)]!;
        temporaryUnavailableCloses += 1;
        options.onStatus?.("reconnecting");
        try { await sleep(delay, options.signal); } catch (error) { if (options.signal.aborted) return; throw error; }
        continue;
      }
      options.onStatus?.("failed");
      throw streamOpenError(response.status);
    }
    options.onStatus?.("connected");
    const startingSequence = lastAppliedSequence;
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let streamFailureMessage: string | null = null;
    let streamUnavailableMessage: string | null = null;
    const applyLine = (line: string) => {
      const frame = parseFrame(line);
      if (frame === null) return;
      if ("frameType" in frame) {
        if (options.isTerminal()) return;
        if (frame.frameType === "stream.unavailable") {
          streamUnavailableMessage = boundedControlMessage(frame, DEFAULT_UNAVAILABLE_MESSAGE);
          lastUnavailableMessage = streamUnavailableMessage;
          options.onStatus?.("unavailable");
        } else if (frame.frameType === "stream.failed") {
          streamFailureMessage = boundedControlMessage(frame, DEFAULT_FAILED_MESSAGE);
          options.onStatus?.("failed");
        }
        options.onControl?.(frame);
        return;
      }
      if (options.signal.aborted) return;
      const canonical = canonicalFrame(frame);
      if (canonical === null) return;
      if (options.sessionId !== undefined && canonical.sessionId !== options.sessionId) throw new Error("The AI event stream session identity changed.");
      if (canonical.sequence === lastAppliedSequence) {
        if (lastAppliedEventId !== null && canonical.eventId === lastAppliedEventId) return;
        throw new Error("The AI event stream contains a conflicting event identity.");
      }
      if (canonical.sequence < lastAppliedSequence) throw new Error("The AI event stream contains an out-of-order sequence.");
      if (canonical.sequence !== lastAppliedSequence + 1) throw new Error("The AI event stream sequence is not contiguous.");
      const applied = options.apply(canonical);
      if (options.signal.aborted) return;
      if (applied === false) throw new Error("The AI event stream event was not applied.");
      lastAppliedSequence = canonical.sequence;
      lastAppliedEventId = canonical.eventId;
    };
    let completedNormally = false;
    const cancelOnAbort = () => { cancelReader(reader, options.signal.reason).catch(() => undefined); };
    options.signal.addEventListener("abort", cancelOnAbort, { once: true });
    try {
      while (!options.signal.aborted) {
        const next = await reader.read();
        if (next.done) {
          buffer += decoder.decode();
          if (buffer !== "") applyLine(buffer.endsWith("\n") ? buffer.slice(0, -1) : buffer);
          break;
        }
        buffer += decoder.decode(next.value, { stream: true });
        let newline = buffer.indexOf("\n");
        while (newline >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          applyLine(line.endsWith("\r") ? line.slice(0, -1) : line);
          newline = buffer.indexOf("\n");
        }
      }
      completedNormally = true;
    } catch (error) {
      await cancelReader(reader, error);
      if (options.signal.aborted) return;
      throw error;
    } finally {
      options.signal.removeEventListener("abort", cancelOnAbort);
      if (!completedNormally && options.signal.aborted) await cancelReader(reader, options.signal.reason);
      reader.releaseLock();
    }
    if (options.signal.aborted) return;
    if (options.isTerminal()) return;
    if (streamFailureMessage !== null) throw new BrowserAiStreamError(streamFailureMessage, "failed");
    if (streamUnavailableMessage !== null) {
      if (temporaryUnavailableCloses >= RETRY_DELAYS_MS.length) {
        options.onStatus?.("unavailable");
        throw new BrowserAiStreamError(lastUnavailableMessage, "unavailable");
      }
      const delay = RETRY_DELAYS_MS[Math.min(temporaryUnavailableCloses, RETRY_DELAYS_MS.length - 1)]!;
      temporaryUnavailableCloses += 1;
      options.onStatus?.("reconnecting");
      try { await sleep(delay, options.signal); } catch (error) { if (options.signal.aborted) return; throw error; }
      continue;
    }
    temporaryUnavailableCloses = 0;
    if (lastAppliedSequence === startingSequence) {
      if (zeroProgressCloses >= RETRY_DELAYS_MS.length) {
        options.onStatus?.("failed");
        throw new BrowserAiStreamError(DEFAULT_FAILED_MESSAGE, "failed");
      }
      const delay = RETRY_DELAYS_MS[Math.min(zeroProgressCloses, RETRY_DELAYS_MS.length - 1)]!;
      zeroProgressCloses += 1;
      options.onStatus?.("reconnecting");
      try { await sleep(delay, options.signal); } catch (error) { if (options.signal.aborted) return; throw error; }
    } else {
      zeroProgressCloses = 0;
    }
  }
}
