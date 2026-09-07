import { mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { OperationJournal } from "./operation-journal.js";
import { durableJsonWriter, type AtomicJsonWriter } from "./private-state.js";

const operationId = "018f0f00-0000-7000-8000-000000000001";
const otherOperationId = "018f0f00-0000-7000-8000-000000000002";
const projectId = "018f0f00-0000-7000-8000-000000000010";
const timestamp = "2026-07-17T12:00:00.000Z";
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

async function root(): Promise<string> { const value = await mkdtemp(path.join(tmpdir(), "devspace-journal-test-")); directories.push(value); return value; }
const request = { projectId };

test("first acceptance, exact replay, conflicts, terminal reload, and restart recovery are durable", async () => {
  const directory = await root();
  const journal = new OperationJournal(directory, () => new Date(timestamp)); await journal.initialize();
  const accepted = await journal.accept(operationId, "project.fetch", request);
  expect(accepted).toMatchObject({ operationId, state: "accepted", request });
  await expect(journal.accept(operationId, "project.fetch", request)).resolves.toEqual(accepted);
  await expect(journal.accept(operationId, "workspace.create", request)).rejects.toMatchObject({ reason: "operation-name-mismatch" });
  await expect(journal.accept(operationId, "project.fetch", { projectId: otherOperationId })).rejects.toMatchObject({ reason: "request-mismatch" });
  await journal.markRunning(operationId);
  expect(journal.observations()).toEqual([{ operationId, state: "running", updatedAt: timestamp, failure: null }]);
  const restartedRunning = new OperationJournal(directory, () => new Date(timestamp)); await restartedRunning.initialize();
  expect(restartedRunning.resumable()).toEqual([expect.objectContaining({ operationId, state: "running" })]);
  await restartedRunning.succeed(operationId);
  const restartedTerminal = new OperationJournal(directory, () => new Date(timestamp)); await restartedTerminal.initialize();
  expect(restartedTerminal.observations()).toEqual([{ operationId, state: "succeeded", updatedAt: timestamp, failure: null }]);
  await expect(restartedTerminal.accept(operationId, "project.fetch", request)).resolves.toMatchObject({ state: "succeeded" });
});

test("restart terminalizes an interrupted project.push as uncertain without losing its intent", async () => {
  const directory = await root();
  const journal = new OperationJournal(directory, () => new Date(timestamp)); await journal.initialize();
  const pushRequest = {
    projectId,
    workspaceId: otherOperationId,
    source: { kind: "github-app", connectionId: "018f0d84-7b39-7cc3-9d4a-0675d9162a11", repositoryId: "9007199254740993" },
    branchName: "feature/push",
    commitOid: "a".repeat(40),
    githubAuthorityGeneration: 1
  };
  await journal.accept(operationId, "project.push", pushRequest);
  await journal.markRunning(operationId);
  const restarted = new OperationJournal(directory, () => new Date("2026-07-17T12:00:01.000Z")); await restarted.initialize();
  expect(restarted.get(operationId)).toMatchObject({
    state: "failed",
    request: pushRequest,
    failure: { code: "GITHUB_PUSH_OUTCOME_UNCERTAIN", retryable: false, details: {} }
  });
  expect(restarted.resumable()).toEqual([]);
  const reloaded = new OperationJournal(directory, () => new Date(timestamp)); await reloaded.initialize();
  expect(reloaded.get(operationId)).toMatchObject({ state: "failed", failure: { code: "GITHUB_PUSH_OUTCOME_UNCERTAIN" } });
});

test("concurrent exact acceptance converges and conflicting acceptance cannot overwrite intent", async () => {
  const directory = await root();
  const journal = new OperationJournal(directory, () => new Date(timestamp)); await journal.initialize();
  const exact = await Promise.all(Array.from({ length: 20 }, async () => await journal.accept(operationId, "project.fetch", request)));
  expect(new Set(exact.map((record) => record.requestFingerprint)).size).toBe(1);
  expect((await readdir(directory)).filter((name) => name.endsWith(".json"))).toEqual([`${operationId}.json`]);
  const outcomes = await Promise.allSettled([
    journal.accept(otherOperationId, "project.fetch", request),
    journal.accept(otherOperationId, "project.fetch", { projectId: operationId })
  ]);
  expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
  expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
});

test.each([
  ["invalid JSON", "not-json\n"],
  ["unknown field", JSON.stringify({ version: 1, unexpected: true })],
  ["semantically forged terminal", JSON.stringify({
    version: 1, operationId, operationName: "project.fetch", requestFingerprint: "0".repeat(64), request,
    state: "succeeded", acceptedAt: timestamp, updatedAt: timestamp,
    failure: { code: "SOURCE_UNAVAILABLE", message: "bad", retryable: true, details: {} }
  })]
])("%s private state degrades the journal and blocks mutation", async (_name, contents) => {
  const directory = await root(); await writeFile(path.join(directory, `${operationId}.json`), contents, "utf8");
  const journal = new OperationJournal(directory, () => new Date(timestamp)); await journal.initialize();
  expect(journal.isHealthy).toBe(false);
  expect(() => journal.observations()).toThrow(/corrupt/u);
  await expect(journal.accept(otherOperationId, "project.fetch", request)).rejects.toThrow(/corrupt/u);
});

test("filename/content mismatch and unexpected journal filenames fail closed", async () => {
  const directory = await root();
  const valid = new OperationJournal(directory, () => new Date(timestamp)); await valid.initialize();
  await valid.accept(operationId, "project.fetch", request);
  await writeFile(path.join(directory, `${otherOperationId}.json`), await readFile(path.join(directory, `${operationId}.json`)));
  await writeFile(path.join(directory, "operation.json.bak"), "{}\n", "utf8");
  const restarted = new OperationJournal(directory, () => new Date(timestamp)); await restarted.initialize();
  expect(restarted.isHealthy).toBe(false);
  expect(restarted.corruptionReason).toMatch(/filename|invalid journal filename/u);
});

test("an atomic write failure leaves the last durable state authoritative", async () => {
  const directory = await root(); let writes = 0;
  const writer: AtomicJsonWriter = { async write(file, value) {
    writes += 1;
    if (writes === 2) throw new Error("disk-failure");
    await durableJsonWriter.write(file, value);
  } };
  const journal = new OperationJournal(directory, () => new Date(timestamp), writer); await journal.initialize();
  await journal.accept(operationId, "project.fetch", request);
  await expect(journal.markRunning(operationId)).rejects.toThrow("disk-failure");
  expect(journal.get(operationId)).toMatchObject({ state: "accepted" });
  const restarted = new OperationJournal(directory, () => new Date(timestamp)); await restarted.initialize();
  expect(restarted.isHealthy).toBe(true);
  expect(restarted.resumable()).toEqual([expect.objectContaining({ state: "accepted" })]);
  expect((await readdir(directory)).some((name) => name.endsWith(".tmp"))).toBe(false);
});

test("replacing the journal root fails closed before acceptance or observation", async () => {
  const directory = await root();
  const journal = new OperationJournal(directory, () => new Date(timestamp)); await journal.initialize();
  const outside = `${directory}-outside`; directories.push(outside); await mkdir(outside);
  const original = `${directory}-original`; directories.push(original); await rename(directory, original);
  await symlink(outside, directory);
  expect(journal.isHealthy).toBe(false);
  expect(() => journal.observations()).toThrow(/corrupt/u);
  await expect(journal.accept(operationId, "project.fetch", request)).rejects.toThrow(/corrupt/u);
  expect(await readdir(outside)).toEqual([]);
});

test("an initially symlinked journal root performs zero writes in its target", async () => {
  const base = await root();
  const target = path.join(base, "external"); await mkdir(target);
  await writeFile(path.join(target, "sentinel"), "unchanged", "utf8");
  const configured = path.join(base, "journal"); await symlink(target, configured);
  const before = await readdir(target);
  const journal = new OperationJournal(configured, () => new Date(timestamp)); await journal.initialize();
  expect(journal.isHealthy).toBe(false);
  expect(await readdir(target)).toEqual(before);
  expect(await readFile(path.join(target, "sentinel"), "utf8")).toBe("unchanged");
});

test("an initially non-directory journal root is rejected without replacement", async () => {
  const base = await root(); const configured = path.join(base, "journal");
  await writeFile(configured, "sentinel", "utf8");
  const journal = new OperationJournal(configured, () => new Date(timestamp)); await journal.initialize();
  expect(journal.isHealthy).toBe(false);
  expect(await readFile(configured, "utf8")).toBe("sentinel");
});

test("a missing configured journal root is never created", async () => {
  const base = await root(); const configured = path.join(base, "missing-journal");
  const journal = new OperationJournal(configured, () => new Date(timestamp)); await journal.initialize();
  expect(journal.isHealthy).toBe(false);
  await expect(readdir(configured)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readdir(base)).toEqual([]);
});
