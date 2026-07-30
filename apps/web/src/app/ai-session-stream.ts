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
type ConsumeAiEventStreamOptions = {
  initialSequence: number;
  sessionId?: string;
  signal: AbortSignal;
  open: (afterSequence: number, signal: AbortSignal) => Promise<Response>;
  apply: (event: BrowserAiEvent) => void;
  isTerminal: () => boolean;
  sleep?: (delayMs: number, signal: AbortSignal) => Promise<void>;
};

const RETRY_DELAYS_MS = [100, 200, 400, 800, 1_600, 3_000] as const;

async function defaultSleep(delayMs: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, delayMs);
    const abort = () => { clearTimeout(timer); reject(signal.reason instanceof Error ? signal.reason : new DOMException("The stream was aborted.", "AbortError")); };
    if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
  });
}

function parseFrame(line: string): BrowserAiStreamFrame | null {
  if (line === "") return null;
  return JSON.parse(line) as BrowserAiStreamFrame;
}

export async function consumeAiEventStream(options: ConsumeAiEventStreamOptions): Promise<void> {
  const sleep = options.sleep ?? defaultSleep;
  let lastAppliedSequence = options.initialSequence;
  let zeroProgressCloses = 0;
  while (!options.signal.aborted && !options.isTerminal()) {
    let response: Response;
    try { response = await options.open(lastAppliedSequence, options.signal); }
    catch (error) { if (options.signal.aborted) return; throw error; }
    if (!response.ok || response.body === null) throw new Error("The AI event stream could not be opened.");
    const startingSequence = lastAppliedSequence;
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const applyLine = (line: string) => {
      const frame = parseFrame(line);
      if (frame === null || "frameType" in frame) return;
      if (options.signal.aborted) return;
      if (options.sessionId !== undefined && frame.sessionId !== options.sessionId) throw new Error("The AI event stream session identity changed.");
      if (frame.sequence <= lastAppliedSequence) return;
      if (frame.sequence !== lastAppliedSequence + 1) throw new Error("The AI event stream sequence is not contiguous.");
      options.apply(frame);
      lastAppliedSequence = frame.sequence;
    };
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
    } finally {
      reader.releaseLock();
    }
    if (options.signal.aborted) return;
    if (options.isTerminal()) return;
    if (lastAppliedSequence === startingSequence) {
      const delay = RETRY_DELAYS_MS[Math.min(zeroProgressCloses, RETRY_DELAYS_MS.length - 1)]!;
      zeroProgressCloses += 1;
      try { await sleep(delay, options.signal); } catch (error) { if (options.signal.aborted) return; throw error; }
    } else {
      zeroProgressCloses = 0;
    }
  }
}
