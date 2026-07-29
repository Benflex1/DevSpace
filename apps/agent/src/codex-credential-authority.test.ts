import { chmod, lstat, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Duplex } from "node:stream";
import { describe, expect, test } from "vitest";
import {
  createCodexCredentialAuthority,
  readStagedAuth,
  validateCodexChatGptAuthority,
  type CodexCredentialAuthority
} from "./codex-credential-authority.js";
import type { DockerEngineClient } from "./docker-runtime.js";

const syntheticIdToken = [
  Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url"),
  Buffer.from(JSON.stringify({ sub: "synthetic-subject" })).toString("base64url"),
  Buffer.from("synthetic-signature").toString("base64url")
].join(".");
const syntheticTokens = {
  id_token: syntheticIdToken,
  access_token: "synthetic-access-value",
  refresh_token: "synthetic-refresh-value",
  account_id: "synthetic-account-value"
};
const completeAuthority = () => JSON.stringify({
  auth_mode: "chatgpt",
  OPENAI_API_KEY: null,
  tokens: syntheticTokens,
  last_refresh: "2026-07-29T10:00:00.000Z"
});

async function authorityFixture(): Promise<{ root: string; authority: CodexCredentialAuthority }> {
  const root = await mkdtemp(join(tmpdir(), "devspace-codex-authority-test-"));
  const authority = createCodexCredentialAuthority(root);
  await mkdir(authority.authorityDir, { recursive: true, mode: 0o700 });
  await chmod(authority.authorityDir, 0o700);
  return { root, authority };
}

async function writeAuthority(authority: CodexCredentialAuthority, contents = completeAuthority()): Promise<void> {
  await writeFile(authority.authPath, contents, { mode: 0o600 });
  await chmod(authority.authPath, 0o600);
}

type StagedSnapshot = Readonly<{
  dev: bigint;
  ino: bigint;
  size: bigint;
  mode: bigint;
  uid: bigint;
  nlink: bigint;
  executionUid: bigint;
}>;

type StagedProof = Readonly<{
  before: StagedSnapshot;
  bytes: Buffer;
  after: StagedSnapshot;
}>;

function stagedProof(bytes: Buffer, changes: Partial<{ before: Partial<StagedSnapshot>; after: Partial<StagedSnapshot> }> = {}): StagedProof {
  const base: StagedSnapshot = { dev: 7n, ino: 42n, size: BigInt(bytes.length), mode: 0o100600n, uid: 1000n, nlink: 1n, executionUid: 1000n };
  return { before: { ...base, ...changes.before }, bytes, after: { ...base, ...changes.after } };
}

function writeU64(value: bigint): Buffer {
  const result = Buffer.alloc(8); result.writeBigUInt64BE(value); return result;
}

function privateStagedFrame(proof: StagedProof): Buffer {
  const metadata = Buffer.concat([
    ...[proof.before, proof.after].flatMap((snapshot) => [snapshot.dev, snapshot.ino, snapshot.size, snapshot.mode, snapshot.uid, snapshot.nlink, snapshot.executionUid].map(writeU64))
  ]);
  const header = Buffer.alloc(20);
  Buffer.from("DSAUTH01", "ascii").copy(header, 0);
  header.writeUInt32BE(1, 8); header.writeUInt32BE(metadata.length, 12); header.writeUInt32BE(proof.bytes.length, 16);
  return Buffer.concat([header, metadata, proof.bytes]);
}

function dockerFrame(value: Uint8Array, stream = 1): Buffer {
  const header = Buffer.alloc(8); header[0] = 1; header.writeUInt32BE(value.byteLength, 4);
  header[0] = stream;
  return Buffer.concat([header, Buffer.from(value)]);
}

function stagedDocker(proofs: readonly (StagedProof | Buffer | null)[], options: { readonly exitCodes?: readonly number[]; readonly captured?: Array<Record<string, unknown>> } = {}): DockerEngineClient {
  let sequence = 0;
  return {
    createExec: (_containerId: string, input: Parameters<DockerEngineClient["createExec"]>[1]) => {
      options.captured?.push({ input });
      return Promise.resolve(`readback-${++sequence}`);
    },
    startExecAttached: (execId: string) => {
      const stream = new Duplex({ read() { /* output is pushed on the next turn */ }, write(_chunk, _encoding, callback) { callback(); } });
      const proof = proofs[Number(execId.slice("readback-".length)) - 1] ?? null;
      process.nextTick(() => {
        if (proof === null) { /* model a helper that emitted no private frame */ }
        else if (Buffer.isBuffer(proof)) stream.push(dockerFrame(proof));
        else stream.push(dockerFrame(privateStagedFrame(proof)));
        setImmediate(() => stream.emit("close"));
      });
      return Promise.resolve(stream);
    },
    inspectExec: (execId: string) => Promise.resolve({ ID: execId, Running: false, ExitCode: options.exitCodes?.[Number(execId.slice("readback-".length)) - 1] ?? 0, ContainerID: "synthetic-container" })
  } as unknown as DockerEngineClient;
}

describe("Codex credential authority", () => {
  test("rejects missing last_refresh", () => {
    const document = JSON.parse(completeAuthority()) as Record<string, unknown>;
    delete document.last_refresh;
    expect(() => validateCodexChatGptAuthority(JSON.stringify(document))).toThrow("last-refresh");
  });

  test("accepts a complete pinned ChatGPT authority without projecting it", () => {
    const validated = validateCodexChatGptAuthority(completeAuthority());
    expect(validated.bytes.toString("utf8")).toBe(completeAuthority());
    expect(validated.bytes.toString("utf8")).toContain('"OPENAI_API_KEY":null');
    expect(validated.bytes.toString("utf8")).toContain("synthetic-access-value");
  });

  test("accepts an omitted OPENAI_API_KEY", () => {
    const document = JSON.parse(completeAuthority()) as Record<string, unknown>;
    delete document.OPENAI_API_KEY;
    const input = JSON.stringify(document);
    const validated = validateCodexChatGptAuthority(input);
    expect(validated.bytes.toString("utf8")).toBe(input);
  });

  test("rejects a non-null OPENAI_API_KEY without exposing its value", () => {
    const document = JSON.parse(completeAuthority()) as Record<string, unknown>;
    const value = "synthetic-api-key-value";
    document.OPENAI_API_KEY = value;
    let error: unknown;
    try { validateCodexChatGptAuthority(JSON.stringify(document)); }
    catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain("authority-fields");
    expect(String(error)).not.toContain(value);
  });

  test.each(["agent_identity", "personal_access_token", "bedrock_api_key"])(
    "rejects unrelated pinned field %s",
    (field) => {
      const document = JSON.parse(completeAuthority()) as Record<string, unknown>;
      document[field] = "synthetic-unrelated-value";
      expect(() => validateCodexChatGptAuthority(JSON.stringify(document))).toThrow("authority-fields");
    }
  );

  test("rejects an unknown top-level field", () => {
    const document = JSON.parse(completeAuthority()) as Record<string, unknown>;
    document.synthetic_unknown = "synthetic-unknown-value";
    expect(() => validateCodexChatGptAuthority(JSON.stringify(document))).toThrow("authority-fields");
  });

  test.each(["apikey", "personalAccessToken", "bedrockApiKey", "agentIdentity", "headers"])(
    "rejects unsupported authentication mode %s",
    (authMode) => {
      const document = JSON.parse(completeAuthority()) as Record<string, unknown>;
      document.auth_mode = authMode;
      expect(() => validateCodexChatGptAuthority(JSON.stringify(document))).toThrow("auth-mode");
    }
  );

  test("rejects symlink authority", async () => {
    const fixture = await authorityFixture();
    try {
      const outside = join(fixture.root, "outside.json");
      await writeFile(outside, completeAuthority(), { mode: 0o600 });
      await symlink(outside, fixture.authority.authPath);
      await expect(fixture.authority.read()).rejects.toThrow("authority-file");
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  test("rejects wrong mode and wrong file type", async () => {
    const fixture = await authorityFixture();
    try {
      await writeAuthority(fixture.authority);
      await chmod(fixture.authority.authPath, 0o644);
      await expect(fixture.authority.read()).rejects.toThrow("authority-file");
      await rm(fixture.authority.authPath);
      await mkdir(fixture.authority.authPath, { mode: 0o700 });
      await expect(fixture.authority.read()).rejects.toThrow("authority-file");
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  test("rejects oversized and malformed authority", async () => {
    const fixture = await authorityFixture();
    try {
      await writeAuthority(fixture.authority, "{".repeat(65 * 1024));
      await expect(fixture.authority.read()).rejects.toThrow("authority-file");
      await writeAuthority(fixture.authority, "{malformed");
      await expect(fixture.authority.read()).rejects.toThrow("authority-json");
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  test("one lease acquisition succeeds and a competing acquisition fails closed", async () => {
    const fixture = await authorityFixture();
    const competing = createCodexCredentialAuthority(fixture.root);
    try {
      const first = await fixture.authority.acquire({ aiSessionId: "synthetic-session", workspaceId: "synthetic-workspace", processGeneration: 1 });
      await expect(competing.acquire({ aiSessionId: "other-session", workspaceId: "other-workspace", processGeneration: 1 })).rejects.toThrow("lease");
      await first.release();
      const second = await competing.acquire({ aiSessionId: "other-session", workspaceId: "other-workspace", processGeneration: 1 });
      await second.release();
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  test("does not automatically remove a stale lease", async () => {
    const fixture = await authorityFixture();
    try {
      await mkdir(fixture.authority.leaseDir, { mode: 0o700 });
      const competing = createCodexCredentialAuthority(fixture.root);
      await expect(competing.acquire({ aiSessionId: "new-session", workspaceId: "new-workspace", processGeneration: 1 })).rejects.toThrow("lease");
      expect((await lstat(fixture.authority.leaseDir)).isDirectory()).toBe(true);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  test("a recovered lease cannot be removed by an old lease handle", async () => {
    const fixture = await authorityFixture();
    try {
      const first = await fixture.authority.acquire({ aiSessionId: "first-session", workspaceId: "synthetic-workspace", processGeneration: 1 });
      await rm(fixture.authority.leaseDir, { recursive: true, force: true });
      const second = await fixture.authority.acquire({ aiSessionId: "second-session", workspaceId: "synthetic-workspace", processGeneration: 2 });
      await expect(first.release()).rejects.toThrow("lease-release");
      expect((await lstat(fixture.authority.leaseDir)).isDirectory()).toBe(true);
      await second.release();
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  test("repeated release after proven success is idempotent", async () => {
    const fixture = await authorityFixture();
    let removeAttempts = 0;
    const authority = createCodexCredentialAuthority(fixture.root, {
      leaseFileSystem: { remove: async (target) => { removeAttempts += 1; await rm(target, { recursive: true, force: false }); } }
    });
    try {
      const lease = await authority.acquire({ aiSessionId: "synthetic-session", workspaceId: "synthetic-workspace", processGeneration: 1 });
      await lease.release(); await lease.release();
      expect(removeAttempts).toBe(1);
    } finally { await rm(fixture.root, { recursive: true, force: true }); }
  });

  test("returns failure after removal fails and retries the owned release path", async () => {
    const fixture = await authorityFixture();
    let removeAttempts = 0;
    const authority = createCodexCredentialAuthority(fixture.root, {
      leaseFileSystem: { remove: async (target) => {
        removeAttempts += 1;
        if (removeAttempts === 1) throw new Error("synthetic-remove-failure");
        await rm(target, { recursive: true, force: false });
      } }
    });
    try {
      const lease = await authority.acquire({ aiSessionId: "synthetic-session", workspaceId: "synthetic-workspace", processGeneration: 1 });
      await expect(lease.release()).rejects.toThrow("lease-release");
      expect((await readdir(fixture.authority.authorityDir)).some((name) => name.startsWith(".lease-release-") )).toBe(true);
      await expect(lease.release()).resolves.toBeUndefined();
      expect(removeAttempts).toBe(2);
    } finally { await rm(fixture.root, { recursive: true, force: true }); }
  });

  test("does not remove an already-absent owned release path on retry", async () => {
    const fixture = await authorityFixture();
    let removeAttempts = 0;
    const authority = createCodexCredentialAuthority(fixture.root, {
      leaseFileSystem: { remove: async (target) => {
        removeAttempts += 1;
        await rm(target, { recursive: true, force: false });
        if (removeAttempts === 1) throw new Error("synthetic-after-remove");
      } }
    });
    try {
      const lease = await authority.acquire({ aiSessionId: "synthetic-session", workspaceId: "synthetic-workspace", processGeneration: 1 });
      await expect(lease.release()).rejects.toThrow("lease-release");
      await expect(lease.release()).resolves.toBeUndefined();
      expect(removeAttempts).toBe(1);
    } finally { await rm(fixture.root, { recursive: true, force: true }); }
  });

  test("fails closed when a replacement lease appears during a post-rename retry", async () => {
    const fixture = await authorityFixture();
    let failVerification = true;
    let releasePathChecks = 0;
    const authority = createCodexCredentialAuthority(fixture.root, {
      leaseFileSystem: { lstat: async (target) => {
        if (target.includes(".lease-release-")) releasePathChecks += 1;
        if (failVerification && releasePathChecks === 2) { failVerification = false; throw new Error("synthetic-verification-failure"); }
        await lstat(target);
      }, remove: async (target) => await rm(target, { recursive: true, force: false }) }
    });
    const competing = createCodexCredentialAuthority(fixture.root);
    try {
      const lease = await authority.acquire({ aiSessionId: "synthetic-session", workspaceId: "synthetic-workspace", processGeneration: 1 });
      await expect(lease.release()).rejects.toThrow("lease-release");
      const replacement = await competing.acquire({ aiSessionId: "replacement-session", workspaceId: "synthetic-workspace", processGeneration: 2 });
      await expect(lease.release()).rejects.toThrow("lease-release");
      await expect(competing.inspect()).rejects.toThrow("credential-unavailable");
      await replacement.release();
    } finally { await rm(fixture.root, { recursive: true, force: true }); }
  });

  test("rejects replaced lease metadata before rename", async () => {
    const fixture = await authorityFixture();
    try {
      const lease = await fixture.authority.acquire({ aiSessionId: "synthetic-session", workspaceId: "synthetic-workspace", processGeneration: 1 });
      await writeFile(join(fixture.authority.leaseDir, "metadata.json"), "foreign-metadata", { mode: 0o600 });
      await expect(lease.release()).rejects.toThrow("lease-release");
      expect((await lstat(fixture.authority.leaseDir)).isDirectory()).toBe(true);
    } finally { await rm(fixture.root, { recursive: true, force: true }); }
  });

  test.each(["missing", "malformed"])("rejects %s lease metadata before rename", async (kind) => {
    const fixture = await authorityFixture();
    try {
      const lease = await fixture.authority.acquire({ aiSessionId: "synthetic-session", workspaceId: "synthetic-workspace", processGeneration: 1 });
      if (kind === "missing") await rm(join(fixture.authority.leaseDir, "metadata.json"));
      else await writeFile(join(fixture.authority.leaseDir, "metadata.json"), "{malformed", { mode: 0o600 });
      await expect(lease.release()).rejects.toThrow("lease-release");
      expect((await lstat(fixture.authority.leaseDir)).isDirectory()).toBe(true);
    } finally { await rm(fixture.root, { recursive: true, force: true }); }
  });

  test("keeps a lease handle retryable after transient absence verification failure", async () => {
    const fixture = await authorityFixture();
    let failVerification = true;
    let releasePathChecks = 0;
    const authority = createCodexCredentialAuthority(fixture.root, {
      leaseFileSystem: { lstat: async (target) => {
        if (target.includes(".lease-release-")) releasePathChecks += 1;
        if (failVerification && releasePathChecks === 2) { failVerification = false; throw new Error("synthetic-verification-failure"); }
        await lstat(target);
      }, remove: async (target) => await rm(target, { recursive: true, force: false }) }
    });
    try {
      const lease = await authority.acquire({ aiSessionId: "synthetic-session", workspaceId: "synthetic-workspace", processGeneration: 1 });
      await expect(lease.release()).rejects.toThrow("lease-release");
      await expect(lease.release()).resolves.toBeUndefined();
    } finally { await rm(fixture.root, { recursive: true, force: true }); }
  });

  test("marks a handle released only after both lease paths are proven absent", async () => {
    const fixture = await authorityFixture();
    let failVerification = true;
    let releasePathChecks = 0;
    const authority = createCodexCredentialAuthority(fixture.root, {
      leaseFileSystem: { lstat: async (target) => {
        if (target.includes(".lease-release-")) releasePathChecks += 1;
        if (failVerification && releasePathChecks === 2) { failVerification = false; throw new Error("synthetic-verification-failure"); }
        await lstat(target);
      }, remove: async (target) => await rm(target, { recursive: true, force: false }) }
    });
    const competing = createCodexCredentialAuthority(fixture.root);
    try {
      const lease = await authority.acquire({ aiSessionId: "synthetic-session", workspaceId: "synthetic-workspace", processGeneration: 1 });
      await expect(lease.release()).rejects.toThrow("lease-release");
      const replacement = await competing.acquire({ aiSessionId: "replacement-session", workspaceId: "synthetic-workspace", processGeneration: 2 });
      await expect(lease.release()).rejects.toThrow("lease-release");
      await replacement.release();
    } finally { await rm(fixture.root, { recursive: true, force: true }); }
  });

  test("does not expose credential values in safe authority errors", async () => {
    const fixture = await authorityFixture();
    try {
      await writeAuthority(fixture.authority, completeAuthority().replace("synthetic-refresh-value", "synthetic-refresh-value\u0000"));
      await expect(fixture.authority.read()).rejects.toSatisfy((error: unknown) => !String(error).includes("synthetic-refresh-value"));
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  test("accepts a complete same-descriptor proof and invokes only the fixed Agent helper", async () => {
    const bytes = Buffer.from(completeAuthority());
    const captured: Array<Record<string, unknown>> = [];
    const result = await readStagedAuth({ docker: stagedDocker([stagedProof(bytes)], { captured }), containerId: "synthetic-container", stagedAuthPath: "/tmp/exact-home/auth.json", readbackHelperPath: "/tmp/agent-helper" });
    expect(result.bytes).toEqual(bytes);
    expect(result.before).toMatchObject({ dev: 7n, ino: 42n, size: BigInt(bytes.length), mode: 0o100600n, uid: 1000n, nlink: 1n, executionUid: 1000n });
    expect(result.after).toEqual(result.before);
    const command = (captured[0]!.input as { command: readonly string[] }).command;
    expect(command).toEqual(["/tmp/agent-helper"]);
    expect(command.join(" ")).not.toMatch(/(?:test|stat|cat)/u);
    expect((captured[0]!.input as { environment: Record<string, string> }).environment).toEqual({ DEVSPACE_TARGET_FILE: "/tmp/exact-home/auth.json" });
  });

  test("rejects a symlink proof from the no-follow helper", async () => {
    const proof = stagedProof(Buffer.from(completeAuthority()), { before: { mode: 0o120600n }, after: { mode: 0o120600n } });
    await expect(readStagedAuth({ docker: stagedDocker([proof]), containerId: "synthetic-container", stagedAuthPath: "/tmp/exact-home/auth.json", readbackHelperPath: "/tmp/agent-helper" })).rejects.toThrow("staged-file");
  });

  test.each([
    ["a directory", 0o040600n],
    ["a device", 0o060600n]
  ])("rejects %s proof", (_label, mode) => expect(readStagedAuth({
    docker: stagedDocker([stagedProof(Buffer.from(completeAuthority()), { before: { mode }, after: { mode } })]),
    containerId: "synthetic-container", stagedAuthPath: "/tmp/exact-home/auth.json", readbackHelperPath: "/tmp/agent-helper"
  })).rejects.toThrow("staged-file"));

  test("rejects a mode other than 0600", async () => {
    const proof = stagedProof(Buffer.from(completeAuthority()), { before: { mode: 0o100644n }, after: { mode: 0o100644n } });
    await expect(readStagedAuth({ docker: stagedDocker([proof]), containerId: "synthetic-container", stagedAuthPath: "/tmp/exact-home/auth.json", readbackHelperPath: "/tmp/agent-helper" })).rejects.toThrow("staged-file");
  });

  test("rejects a UID different from the helper execution UID", async () => {
    const proof = stagedProof(Buffer.from(completeAuthority()), { before: { uid: 1001n }, after: { uid: 1001n } });
    await expect(readStagedAuth({ docker: stagedDocker([proof]), containerId: "synthetic-container", stagedAuthPath: "/tmp/exact-home/auth.json", readbackHelperPath: "/tmp/agent-helper" })).rejects.toThrow("staged-file");
  });

  test("rejects a hard-linked staged file", async () => {
    const proof = stagedProof(Buffer.from(completeAuthority()), { before: { nlink: 2n }, after: { nlink: 2n } });
    await expect(readStagedAuth({ docker: stagedDocker([proof]), containerId: "synthetic-container", stagedAuthPath: "/tmp/exact-home/auth.json", readbackHelperPath: "/tmp/agent-helper" })).rejects.toThrow("staged-file");
  });

  test.each([
    ["empty", Buffer.alloc(0)],
    ["oversized", Buffer.alloc(64 * 1024 + 1)]
  ])("rejects an %s staged file", (_label, bytes) => expect(readStagedAuth({
    docker: stagedDocker([stagedProof(bytes)]), containerId: "synthetic-container", stagedAuthPath: "/tmp/exact-home/auth.json", readbackHelperPath: "/tmp/agent-helper"
  })).rejects.toThrow("staged-file"));

  test.each([
    ["device", { after: { dev: 8n } }],
    ["inode", { after: { ino: 43n } }],
    ["size", { after: { size: 999n } }]
  ])("rejects a before/after %s change", (_label, change) => expect(readStagedAuth({
    docker: stagedDocker([stagedProof(Buffer.from(completeAuthority()), change)]),
    containerId: "synthetic-container", stagedAuthPath: "/tmp/exact-home/auth.json", readbackHelperPath: "/tmp/agent-helper"
  })).rejects.toThrow("staged-file"));

  test.each([
    ["truncated", Buffer.from("DSAUTH01")],
    ["malformed", Buffer.from("not-a-private-frame")]
  ])("rejects %s private framing", (_label, frame) => expect(readStagedAuth({
    docker: stagedDocker([frame]), containerId: "synthetic-container", stagedAuthPath: "/tmp/exact-home/auth.json", readbackHelperPath: "/tmp/agent-helper"
  })).rejects.toThrow("staged-read"));

  test("rejects a nonzero Docker readback exec", async () => {
    const proof = stagedProof(Buffer.from(completeAuthority()));
    await expect(readStagedAuth({ docker: stagedDocker([proof], { exitCodes: [17] }), containerId: "synthetic-container", stagedAuthPath: "/tmp/exact-home/auth.json", readbackHelperPath: "/tmp/agent-helper" })).rejects.toThrow("staged-file");
  });

  test("rejects equal bytes from different descriptor identities", async () => {
    const fixture = await authorityFixture();
    try {
      await writeAuthority(fixture.authority);
      const bytes = Buffer.from(completeAuthority());
      await expect(fixture.authority.synchronizeStaged({
        docker: stagedDocker([stagedProof(bytes), stagedProof(bytes, { before: { ino: 43n }, after: { ino: 43n } })]),
        containerId: "synthetic-container", stagedAuthPath: "/tmp/exact-home/auth.json", readbackHelperPath: "/tmp/agent-helper"
      })).rejects.toThrow("staged-unstable");
      await expect(fixture.authority.read()).resolves.toMatchObject({ bytes });
    } finally { await rm(fixture.root, { recursive: true, force: true }); }
  });

  test("rejects equal identity from different bytes", async () => {
    const fixture = await authorityFixture();
    try {
      await writeAuthority(fixture.authority);
      const first = Buffer.from(completeAuthority());
      const second = Buffer.from(completeAuthority().replace("synthetic-access-value", "synthetic-access-vAlue"));
      await expect(fixture.authority.synchronizeStaged({
        docker: stagedDocker([stagedProof(first), stagedProof(second)]),
        containerId: "synthetic-container", stagedAuthPath: "/tmp/exact-home/auth.json", readbackHelperPath: "/tmp/agent-helper"
      })).rejects.toThrow("staged-unstable");
      await expect(fixture.authority.read()).resolves.toMatchObject({ bytes: first });
    } finally { await rm(fixture.root, { recursive: true, force: true }); }
  });

  test("keeps private readback framing and Docker surfaces free of credential bytes", async () => {
    const bytes = Buffer.from(completeAuthority());
    const captured: Array<Record<string, unknown>> = [];
    await expect(readStagedAuth({ docker: stagedDocker([stagedProof(bytes, { before: { mode: 0o100644n }, after: { mode: 0o100644n } })], { captured }), containerId: "synthetic-container", stagedAuthPath: "/tmp/exact-home/auth.json", readbackHelperPath: "/tmp/agent-helper" })).rejects.toThrow();
    const surfaces = [captured, "codex-staged-file", "safe-diagnostic", "synthetic-label"];
    expect(JSON.stringify(surfaces)).not.toContain(bytes.toString("utf8"));
  });

  test("synchronizes refreshed access, refresh, and last_refresh atomically", async () => {
    const fixture = await authorityFixture();
    try {
      await writeAuthority(fixture.authority);
      const refreshed = completeAuthority().replace("synthetic-access-value", "synthetic-access-refreshed")
        .replace("synthetic-refresh-value", "synthetic-refresh-refreshed")
        .replace("2026-07-29T10:00:00.000Z", "2026-07-29T10:01:00.000Z");
      await fixture.authority.synchronizeStaged({ docker: stagedDocker([stagedProof(Buffer.from(refreshed)), stagedProof(Buffer.from(refreshed))]), containerId: "synthetic-container", stagedAuthPath: "/tmp/exact-home/auth.json", readbackHelperPath: "/tmp/agent-helper" });
      const stored = (await fixture.authority.read()).bytes.toString("utf8");
      expect(stored).toBe(refreshed);
      expect(stored).toContain("synthetic-access-refreshed");
      expect(stored).toContain("synthetic-refresh-refreshed");
      expect(stored).toContain("2026-07-29T10:01:00.000Z");
      expect((await fixture.authority.read()).document.tokens.refresh_token).toBe("synthetic-refresh-refreshed");
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  test.each([
    ["malformed", Buffer.from("{malformed")],
    ["symlink", Buffer.from("not-used")]
  ])("invalid staged %s output never replaces durable authority", async (kind, staged) => {
    const fixture = await authorityFixture();
    try {
      await writeAuthority(fixture.authority);
      const proof = kind === "symlink" ? stagedProof(staged, { before: { mode: 0o120600n }, after: { mode: 0o120600n } }) : stagedProof(staged);
      await expect(fixture.authority.synchronizeStaged({ docker: stagedDocker([proof, proof]), containerId: "synthetic-container", stagedAuthPath: "/tmp/exact-home/auth.json", readbackHelperPath: "/tmp/agent-helper" })).rejects.toThrow();
      expect((await fixture.authority.read()).bytes.toString("utf8")).toBe(completeAuthority());
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  test("atomic replacement preserves old state on injected write failure and cleans its temporary file", async () => {
    const fixture = await authorityFixture();
    try {
      await writeAuthority(fixture.authority);
      const replacement = Buffer.from(completeAuthority().replace("synthetic-access-value", "synthetic-access-next"));
      await expect(fixture.authority.replaceDurable(replacement, { failAfterWrite: () => { throw new Error("injected-write-failure"); } })).rejects.toThrow("injected-write-failure");
      expect((await fixture.authority.read()).bytes.toString("utf8")).toBe(completeAuthority());
      expect((await readdir(fixture.authority.authorityDir)).filter((name) => name.includes("auth.json.tmp")).length).toBe(0);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  test("reauthentication marker makes inspection unavailable without deleting durable state", async () => {
    const fixture = await authorityFixture();
    try {
      await writeAuthority(fixture.authority);
      await fixture.authority.markReauthenticationRequired();
      await expect(fixture.authority.inspect()).rejects.toThrow("credential-unavailable");
      expect((await fixture.authority.read()).bytes.toString("utf8")).toBe(completeAuthority());
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
});
