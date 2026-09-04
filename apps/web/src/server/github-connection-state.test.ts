import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { openProjectDatabase } from "./database.js";

describe("GitHub connection state", () => {
  it("persists only a state hash and atomically resumes an exact duplicate claim", () => {
    const raw = "one-time-state-secret";
    const stateHash = createHash("sha256").update(raw).digest("hex");
    const database = openProjectDatabase(":memory:", { now: () => new Date("2026-08-04T12:00:00.000Z"),
      createId: () => "018f0d84-7b39-7cc3-9d4a-0675d9162a11" });
    const attempt = database.createGithubConnectionAttempt({ actor: "owner@example.test", stateHash, expiresAt: "2026-08-04T12:10:00.000Z" });
    expect(JSON.stringify(attempt)).not.toContain(raw);
    const first = database.claimGithubConnectionAttempt({ actor: "owner@example.test", stateHash, installationId: "9007199254740993" });
    const duplicate = database.claimGithubConnectionAttempt({ actor: "owner@example.test", stateHash, installationId: "9007199254740993" });
    expect(duplicate).toEqual(first);
    expect(() => database.claimGithubConnectionAttempt({ actor: "owner@example.test", stateHash, installationId: "7" })).toThrow("GITHUB_INSTALLATION_CONFLICT");
    expect(() => database.claimGithubConnectionAttempt({ actor: "foreign@example.test", stateHash, installationId: "9007199254740993" })).toThrow("GITHUB_STATE_INVALID");
    database.close();
  });

  it("rejects expired state", () => {
    const database = openProjectDatabase(":memory:", { now: () => new Date("2026-08-04T12:10:00.000Z"),
      createId: () => "018f0d84-7b39-7cc3-9d4a-0675d9162a11" });
    database.createGithubConnectionAttempt({ actor: "owner", stateHash: "a".repeat(64), expiresAt: "2026-08-04T12:09:59.000Z" });
    expect(() => database.claimGithubConnectionAttempt({ actor: "owner", stateHash: "a".repeat(64), installationId: "1" })).toThrow("GITHUB_STATE_EXPIRED");
    database.close();
  });

  it("serializes concurrent callback claims through the compare-and-swap row version", async () => {
    const database = openProjectDatabase(":memory:", { now: () => new Date("2026-08-04T12:00:00.000Z"),
      createId: () => "018f0d84-7b39-7cc3-9d4a-0675d9162a11" });
    const stateHash = "b".repeat(64);
    database.createGithubConnectionAttempt({ actor: "owner", stateHash, expiresAt: "2026-08-04T12:10:00.000Z" });
    const claims = await Promise.all([
      Promise.resolve().then(() => database.claimGithubConnectionAttempt({ actor: "owner", stateHash, installationId: "77" })),
      Promise.resolve().then(() => database.claimGithubConnectionAttempt({ actor: "owner", stateHash, installationId: "77" }))
    ]);
    expect(claims[0]?.status).toBe("claimed");
    expect(claims[1]?.status).toBe("claimed");
    expect(claims[0]?.rowVersion).toBe(claims[1]?.rowVersion);
    database.close();
  });
});
