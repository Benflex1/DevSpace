import { expect, test } from "vitest";
import * as packageEntry from "./index.js";

test("@devspace/contracts package entry loads as ESM", () => {
  expect(packageEntry).toBeDefined();
});
