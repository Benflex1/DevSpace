import { expect, test } from "vitest";
import * as packageEntry from "./index.js";

test("@devspace/agent package entry loads as ESM", () => {
  expect(packageEntry).toBeDefined();
});
