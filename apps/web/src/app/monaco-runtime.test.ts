import { expect, test } from "vitest";
import { assertMonacoRuntimeIdentity } from "./monaco-runtime.js";

test("rejects a loader result from a different Monaco runtime instance", () => {
  const localRuntime = {};
  const contaminatedRuntime = {};

  expect(() => assertMonacoRuntimeIdentity(localRuntime, contaminatedRuntime)).toThrowError(/MONACO_RUNTIME_MISMATCH/u);
  expect(() => assertMonacoRuntimeIdentity(localRuntime, localRuntime)).not.toThrow();
});
