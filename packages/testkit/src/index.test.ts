import { access, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "vitest";
import { loadJsonFixture, withTemporaryDirectory } from "./index.js";

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

test("temporary directories are unique and cleaned up after success", async () => {
  const first = await withTemporaryDirectory(async (directory) => {
    expect(await pathExists(directory)).toBe(true);
    return directory;
  });
  const second = await withTemporaryDirectory((directory) => Promise.resolve(directory));

  expect(first).not.toBe(second);
  expect(await pathExists(first)).toBe(false);
  expect(await pathExists(second)).toBe(false);
});

test("temporary directories exist during the callback", async () => {
  await withTemporaryDirectory(async (directory) => {
    const marker = join(directory, "marker.txt");
    await writeFile(marker, "fixture", "utf8");

    expect(await pathExists(directory)).toBe(true);
    expect(await pathExists(marker)).toBe(true);
  });
});

test("temporary directories are cleaned up after a throwing callback", async () => {
  let directoryDuringCallback = "";

  await expect(
    withTemporaryDirectory((directory) => {
      directoryDuringCallback = directory;
      return Promise.reject(new Error("callback failed"));
    })
  ).rejects.toThrow("callback failed");

  expect(await pathExists(directoryDuringCallback)).toBe(false);
});

test("loads valid JSON from an absolute path and a file URL", async () => {
  await withTemporaryDirectory(async (directory) => {
    const fixturePath = join(directory, "fixture.json");
    await writeFile(fixturePath, '{"schemaVersion":1,"enabled":true}', "utf8");

    await expect(loadJsonFixture(fixturePath)).resolves.toEqual({ schemaVersion: 1, enabled: true });
    await expect(loadJsonFixture(pathToFileURL(fixturePath))).resolves.toEqual({
      schemaVersion: 1,
      enabled: true
    });
  });
});

test("rejects malformed JSON with the parser failure", async () => {
  await withTemporaryDirectory(async (directory) => {
    const fixturePath = join(directory, "malformed.json");
    await writeFile(fixturePath, '{"schemaVersion":', "utf8");

    await expect(loadJsonFixture(fixturePath)).rejects.toThrow(SyntaxError);
  });
});
