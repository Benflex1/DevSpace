import { expect, test } from "vitest";
import { PROJECT_REGISTRATION_BODY_LIMIT_BYTES, RequestBodyMalformedError, RequestBodyTooLargeError, readBoundedJsonBody } from "./request-body.js";

function requestFromBytes(bytes: Uint8Array): Request {
  const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); controller.close(); } });
  return new Request("http://localhost/api/projects", { method: "POST", body, duplex: "half" } as RequestInit & { duplex: "half" });
}

test("accepts JSON below and exactly at the 16 KiB byte boundary", async () => {
  await expect(readBoundedJsonBody(requestFromBytes(new TextEncoder().encode('{"ok":true}')))).resolves.toEqual({ ok: true });
  const exact = JSON.stringify("x".repeat(PROJECT_REGISTRATION_BODY_LIMIT_BYTES - 2));
  expect(new TextEncoder().encode(exact)).toHaveLength(PROJECT_REGISTRATION_BODY_LIMIT_BYTES);
  await expect(readBoundedJsonBody(requestFromBytes(new TextEncoder().encode(exact)))).resolves.toBe("x".repeat(PROJECT_REGISTRATION_BODY_LIMIT_BYTES - 2));
});

test("rejects an oversized body delivered in one chunk", async () => {
  const oversized = new Uint8Array(PROJECT_REGISTRATION_BODY_LIMIT_BYTES + 1);
  await expect(readBoundedJsonBody(requestFromBytes(oversized))).rejects.toBeInstanceOf(RequestBodyTooLargeError);
});

test("stops and cancels a chunked stream as soon as the byte bound is exceeded", async () => {
  let pulls = 0;
  let cancelled = false;
  const chunks = [
    new Uint8Array(PROJECT_REGISTRATION_BODY_LIMIT_BYTES - 1).fill(0x20),
    new Uint8Array(2).fill(0x20),
    new Uint8Array(8_192).fill(0x20)
  ];
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[pulls++];
      if (chunk === undefined) controller.close();
      else controller.enqueue(chunk);
    },
    cancel() { cancelled = true; }
  });
  const request = new Request("http://localhost/api/projects", {
    method: "POST", body, duplex: "half"
  } as RequestInit & { duplex: "half" });
  await expect(readBoundedJsonBody(request)).rejects.toBeInstanceOf(RequestBodyTooLargeError);
  expect(cancelled).toBe(true);
  expect(pulls).toBe(2);
});

test("decodes split UTF-8 safely and rejects malformed UTF-8", async () => {
  const encoded = new TextEncoder().encode('{"value":"€"}');
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoded.slice(0, 11));
      controller.enqueue(encoded.slice(11));
      controller.close();
    }
  });
  await expect(readBoundedJsonBody(new Request("http://localhost/api/projects", {
    method: "POST", body, duplex: "half"
  } as RequestInit & { duplex: "half" }))).resolves.toEqual({ value: "€" });
  await expect(readBoundedJsonBody(requestFromBytes(Uint8Array.of(0xc3, 0x28)))).rejects.toBeInstanceOf(RequestBodyMalformedError);
});
