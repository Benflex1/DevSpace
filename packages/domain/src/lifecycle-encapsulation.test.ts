import { expect, expectTypeOf, test } from "vitest";
import * as packageEntry from "./index.js";
import { createTransitionTable } from "./lifecycle.js";

test("the package root exports no production transition tables", () => {
  const transitionTableExports = Object.keys(packageEntry).filter((name) =>
    name.endsWith("Transitions")
  );
  expect(transitionTableExports).toEqual([]);

  type TransitionTableExport = Extract<keyof typeof packageEntry, `${string}Transitions`>;
  expectTypeOf<TransitionTableExport>().toEqualTypeOf<never>();

  type ExportedFunctionReturn = {
    [Name in keyof typeof packageEntry]: typeof packageEntry[Name] extends (
      ...arguments_: infer _Arguments
    ) => infer Return
      ? Return
      : never;
  }[keyof typeof packageEntry];
  type PublicCollectionReturn = Extract<ExportedFunctionReturn, readonly unknown[]>;
  expectTypeOf<PublicCollectionReturn>().toEqualTypeOf<never>();
});

test("internal transition-table construction freezes the object and every destination collection", () => {
  const table = createTransitionTable<"first" | "second">({
    first: ["second"],
    second: []
  });

  expect(Object.isFrozen(table)).toBe(true);
  expect(Object.values(table).every((targets) => Object.isFrozen(targets))).toBe(true);
  expect(() => {
    (table as Record<string, readonly string[]>).third = [];
  }).toThrow(TypeError);
  expect(() => {
    (table.first as string[]).push("first");
  }).toThrow(TypeError);
});

test("lifecycle functions return results rather than transition collections", () => {
  const result = packageEntry.transitionProject("registering", "invalid");
  expect(result).toEqual({ ok: true, state: "invalid" });
  expect(Array.isArray(result)).toBe(false);
  expect(Object.values(result).some((value) => Array.isArray(value))).toBe(false);
});
