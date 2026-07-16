import { expect, test } from "vitest";
import { withTemporaryDirectory } from "@devspace/testkit";
import * as packageEntry from "./index.js";

test("@devspace/domain package entry loads as ESM with a source-resolved testkit", async () => {
  expect(packageEntry).toBeDefined();

  await withTemporaryDirectory((directory) => Promise.resolve(expect(directory).toBeTruthy()));
});
