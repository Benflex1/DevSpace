import { expect, test } from "vitest";
import {
  canonicalizeJson,
  canonicalizeJsonBytes,
  type JsonValue
} from "./canonical-json.js";

test("canonicalizes equivalent nested objects independently of insertion order", () => {
  const first = { z: { beta: 2, alpha: 1 }, a: true };
  const second = { a: true, z: { alpha: 1, beta: 2 } };
  const expected = '{"a":true,"z":{"alpha":1,"beta":2}}';

  expect(canonicalizeJson(first)).toBe(expected);
  expect(canonicalizeJson(second)).toBe(expected);
  expect(canonicalizeJsonBytes(first)).toEqual(new TextEncoder().encode(expected));
});

test("preserves array order", () => {
  expect(canonicalizeJson({ values: [3, 1, 2] })).toBe('{"values":[3,1,2]}');
  expect(canonicalizeJson({ values: [1, 2, 3] })).not.toBe(
    canonicalizeJson({ values: [3, 1, 2] })
  );
});

test("uses RFC 8785 UTF-16 property ordering without Unicode normalization", () => {
  const value = {
    "€": "Euro Sign",
    "\r": "Carriage Return",
    "\n": "Newline",
    "1": "One",
    "\u0080": "Control\u007f",
    "😂": "Smiley",
    "ö": "Latin Small Letter O With Diaeresis",
    "דּ": "Hebrew Letter Dalet With Dagesh",
    "</script>": "Browser Challenge"
  };

  expect(canonicalizeJson(value)).toBe(
    '{"\\n":"Newline","\\r":"Carriage Return","1":"One","</script>":"Browser Challenge",'
    + '"":"Control","ö":"Latin Small Letter O With Diaeresis","€":"Euro Sign",'
    + '"😂":"Smiley","דּ":"Hebrew Letter Dalet With Dagesh"}'
  );
  expect(canonicalizeJson({ value: "A\u030a" })).not.toBe(canonicalizeJson({ value: "Å" }));
});

test("uses RFC 8785 string escaping", () => {
  expect(canonicalizeJson({ value: "€$\u000f\nA'B\"\\\\\"/" })).toBe(
    '{"value":"€$\\u000f\\nA\'B\\"\\\\\\\\\\"/"}'
  );
});

test("uses ECMAScript number serialization at representative RFC 8785 boundaries", () => {
  expect(canonicalizeJson([
    Number("333333333.33333329"),
    1e30,
    4.50,
    2e-3,
    1e-27,
    1e20,
    1e21,
    1e-6,
    1e-7,
    Number.MIN_VALUE,
    Number.MAX_VALUE
  ])).toBe(
    "[333333333.3333333,1e+30,4.5,0.002,1e-27,100000000000000000000,"
    + "1e+21,0.000001,1e-7,5e-324,1.7976931348623157e+308]"
  );
});

test("canonicalizes negative zero as zero", () => {
  expect(Object.is(-0, 0)).toBe(false);
  expect(canonicalizeJson([-0, 0])).toBe("[0,0]");
});

test("is deterministic across repeated text and byte calls", () => {
  const value = { nested: [{ b: "two", a: "one" }], number: 1e-7 };
  const texts = Array.from({ length: 20 }, () => canonicalizeJson(value));
  const bytes = Array.from(
    { length: 20 },
    () => Buffer.from(canonicalizeJsonBytes(value)).toString("hex")
  );

  expect(new Set(texts).size).toBe(1);
  expect(new Set(bytes).size).toBe(1);
});

test.each([
  ["undefined", undefined],
  ["function", () => undefined],
  ["symbol", Symbol("value")],
  ["bigint", 1n],
  ["NaN", Number.NaN],
  ["positive infinity", Number.POSITIVE_INFINITY],
  ["negative infinity", Number.NEGATIVE_INFINITY],
  ["Date", new Date(0)],
  ["class instance", new (class Example { readonly value = 1; })()],
  ["lone high surrogate", "\ud800"],
  ["lone low surrogate", "\udc00"]
])("rejects unsupported %s input", (_name, value) => {
  expect(() => canonicalizeJson(value as JsonValue)).toThrow(TypeError);
});

test("rejects sparse arrays, symbol properties, accessors, and cycles without lossy coercion", () => {
  const sparse = new Array<JsonValue>(2);
  sparse[1] = "present";
  const symbolProperty = { value: 1 } as Record<PropertyKey, JsonValue>;
  symbolProperty[Symbol("hidden")] = 2;
  const accessor = Object.defineProperty({}, "value", {
    enumerable: true,
    get: () => 1
  });
  const cyclic: { self?: JsonValue } = {};
  cyclic.self = cyclic;

  for (const value of [sparse, symbolProperty, accessor, cyclic]) {
    expect(() => canonicalizeJson(value as JsonValue)).toThrow(TypeError);
  }
});
