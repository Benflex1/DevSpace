const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export const AI_TURN_OUTPUT_MAX_BYTES = 2 * 1024 * 1024;
export const AI_SESSION_OUTPUT_MAX_BYTES = 8 * 1024 * 1024;
export const AI_TURN_ACTIVITY_HISTORY_MAX_ROWS = 256;
export const AI_TURN_ACTIVITY_HISTORY_MAX_BYTES = 256 * 1024;

function utf8CharacterWidth(leadingByte: number): number {
  if (leadingByte <= 0x7f) return 1;
  if (leadingByte <= 0xdf) return 2;
  if (leadingByte <= 0xef) return 3;
  return 4;
}

function longestValidPrefix(value: Uint8Array, maxBytes: number): { readonly value: string; readonly truncated: boolean } {
  let end = Math.max(0, Math.min(value.byteLength, Math.floor(maxBytes)));
  if (end > 0 && end < value.byteLength) {
    let characterStart = end - 1;
    while (characterStart > 0 && (value[characterStart]! & 0xc0) === 0x80) characterStart -= 1;
    if (utf8CharacterWidth(value[characterStart]!) > end - characterStart) end = characterStart;
  }
  for (let candidate = end; candidate >= 0; candidate -= 1) {
    try {
      return { value: decoder.decode(value.subarray(0, candidate)), truncated: candidate < value.byteLength };
    } catch {
      // Drop one byte at a time only for malformed legacy data; valid UTF-8 uses the boundary above.
    }
  }
  return { value: "", truncated: true };
}

export function truncateUtf8(value: string, maxBytes: number): { readonly value: string; readonly truncated: boolean } {
  const bytes = encoder.encode(value);
  if (bytes.byteLength <= maxBytes) return { value, truncated: false };
  return longestValidPrefix(bytes, maxBytes);
}

export function decodeUtf8Prefix(value: Uint8Array, maxBytes: number): { readonly value: string; readonly truncated: boolean } {
  if (value.byteLength <= maxBytes) {
    try { return { value: decoder.decode(value), truncated: false }; } catch { /* normalize malformed legacy data below */ }
  }
  return longestValidPrefix(value, maxBytes);
}

export function utf8ByteLength(value: string): number {
  return encoder.encode(value).byteLength;
}
