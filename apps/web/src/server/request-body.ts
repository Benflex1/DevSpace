export const PROJECT_REGISTRATION_BODY_LIMIT_BYTES = 16 * 1024;

export class RequestBodyTooLargeError extends Error {
  constructor() { super("Request body is too large."); this.name = "RequestBodyTooLargeError"; }
}

export class RequestBodyMalformedError extends Error {
  constructor() { super("Request body must be valid UTF-8 JSON."); this.name = "RequestBodyMalformedError"; }
}

export async function readBoundedJsonBody(request: Request, limit = PROJECT_REGISTRATION_BODY_LIMIT_BYTES): Promise<unknown> {
  if (request.body === null) throw new RequestBodyMalformedError();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      received += result.value.byteLength;
      if (received > limit) {
        void reader.cancel("request-body-limit-exceeded").catch(() => undefined);
        throw new RequestBodyTooLargeError();
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(body); } catch { throw new RequestBodyMalformedError(); }
  try { return JSON.parse(text) as unknown; } catch { throw new RequestBodyMalformedError(); }
}
