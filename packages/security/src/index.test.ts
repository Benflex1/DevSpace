import { expect, test } from "vitest";
import * as packageEntry from "./index.js";

test("@devspace/security package entry loads as ESM", () => {
  expect(packageEntry).toBeDefined();
});
