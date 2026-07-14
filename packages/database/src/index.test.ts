import { expect, test } from "vitest";
import * as packageEntry from "./index.js";

test("@devspace/database package entry loads as ESM", () => {
  expect(packageEntry).toBeDefined();
});
