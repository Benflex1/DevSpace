import canonicalize from "canonicalize";

export type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | readonly JsonValue[] | {
  readonly [key: string]: JsonValue;
};

function assertUnicodeScalarString(value: string, location: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new TypeError(`${location} contains a lone Unicode surrogate`);
      }
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      throw new TypeError(`${location} contains a lone Unicode surrogate`);
    }
  }
}

function assertDataProperty(
  descriptor: PropertyDescriptor | undefined,
  location: string
): asserts descriptor is PropertyDescriptor & { readonly value: unknown } {
  if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
    throw new TypeError(`${location} must be an enumerable data property`);
  }
}

function assertJsonValue(
  value: unknown,
  location: string,
  ancestors: Set<object>
): asserts value is JsonValue {
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "string") {
    assertUnicodeScalarString(value, location);
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError(`${location} contains a non-finite number`);
    }
    return;
  }
  if (typeof value !== "object") {
    throw new TypeError(`${location} is not a JSON value`);
  }
  if (ancestors.has(value)) {
    throw new TypeError(`${location} contains a cyclic reference`);
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const ownKeys = Reflect.ownKeys(value);
      const expectedKeyCount = value.length + 1;
      if (ownKeys.length !== expectedKeyCount || !ownKeys.includes("length")) {
        throw new TypeError(`${location} contains non-index array properties`);
      }
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) {
          throw new TypeError(`${location} contains a sparse array element at index ${index}`);
        }
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        assertDataProperty(descriptor, `${location}[${index}]`);
        assertJsonValue(descriptor.value, `${location}[${index}]`, ancestors);
      }
      return;
    }

    const prototype = Object.getPrototypeOf(value) as object | null;
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`${location} must be a plain JSON object`);
    }
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") {
        throw new TypeError(`${location} contains a symbol property`);
      }
      assertUnicodeScalarString(key, `${location} property name`);
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      assertDataProperty(descriptor, `${location}.${key}`);
      assertJsonValue(descriptor.value, `${location}.${key}`, ancestors);
    }
  } finally {
    ancestors.delete(value);
  }
}

export function canonicalizeJson(value: JsonValue): string {
  assertJsonValue(value, "$", new Set());
  const canonical = canonicalize(value);
  if (canonical === undefined) {
    throw new TypeError("$ is not a JSON value");
  }
  return canonical;
}

export function canonicalizeJsonBytes(value: JsonValue): Uint8Array {
  return new TextEncoder().encode(canonicalizeJson(value));
}
