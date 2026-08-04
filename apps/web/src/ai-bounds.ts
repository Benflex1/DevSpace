const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export const AI_TURN_OUTPUT_MAX_BYTES = 2 * 1024 * 1024;
export const AI_SESSION_OUTPUT_MAX_BYTES = 8 * 1024 * 1024;
export const AI_TURN_ACTIVITY_HISTORY_MAX_ROWS = 256;
export const AI_TURN_ACTIVITY_HISTORY_MAX_BYTES = 256 * 1024;

function longestValidPrefix(value: Uint8Array, maxBytes: number): { readonly value: string; readonly truncated: boolean } {
  const limit = Math.max(0, Math.min(value.byteLength, Math.floor(maxBytes)));
  let offset = 0;
  let validEnd = 0;
  while (offset < limit) {
    const leading = value[offset]!;
    let width: number;
    let codePoint: number;
    if (leading <= 0x7f) {
      width = 1; codePoint = leading;
    } else if (leading >= 0xc2 && leading <= 0xdf) {
      width = 2; codePoint = leading & 0x1f;
    } else if (leading >= 0xe0 && leading <= 0xef) {
      width = 3; codePoint = leading & 0x0f;
    } else if (leading >= 0xf0 && leading <= 0xf4) {
      width = 4; codePoint = leading & 0x07;
    } else {
      break;
    }
    if (offset + width > limit || offset + width > value.byteLength) break;
    let valid = true;
    for (let index = 1; index < width; index += 1) {
      const continuation = value[offset + index]!;
      if ((continuation & 0xc0) !== 0x80) { valid = false; break; }
      codePoint = (codePoint << 6) | (continuation & 0x3f);
    }
    if (!valid || (width === 2 && codePoint < 0x80) || (width === 3 && codePoint < 0x800)
      || (width === 4 && codePoint < 0x10000) || codePoint > 0x10ffff
      || (codePoint >= 0xd800 && codePoint <= 0xdfff)) break;
    offset += width;
    validEnd = offset;
  }
  try {
    return { value: decoder.decode(value.subarray(0, validEnd)), truncated: validEnd < value.byteLength };
  } catch {
    return { value: "", truncated: true };
  }
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
