import { chmod, lstat, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Duplex } from "node:stream";
import { describe, expect, test } from "vitest";
import {
  createCodexCredentialAuthority,
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

function dockerFrame(value: Uint8Array): Buffer {
  const header = Buffer.alloc(8); header[0] = 1; header.writeUInt32BE(value.byteLength, 4);
  return Buffer.concat([header, Buffer.from(value)]);
}

function stagedDocker(bytes: Buffer, metadata = `regular file 600 ${bytes.length}`): DockerEngineClient {
  let sequence = 0;
  return {
    createExec: () => Promise.resolve(`readback-${++sequence}`),
    startExecAttached: () => {
      const stream = new Duplex({ read() { /* output is pushed on the next turn */ }, write(_chunk, _encoding, callback) { callback(); } });
      process.nextTick(() => { stream.push(Buffer.concat([dockerFrame(Buffer.from(`${metadata}\n`)), dockerFrame(bytes)])); setImmediate(() => stream.emit("close")); });
      return Promise.resolve(stream);
    },
    inspectExec: () => Promise.resolve({ ID: "synthetic-readback", Running: false, ExitCode: 0, ContainerID: "synthetic-container" })
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
    expect(validated.bytes.toString("utf8")).toContain("synthetic-access-value");
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

  test("does not expose credential values in safe authority errors", async () => {
    const fixture = await authorityFixture();
    try {
      await writeAuthority(fixture.authority, completeAuthority().replace("synthetic-refresh-value", "synthetic-refresh-value\u0000"));
      await expect(fixture.authority.read()).rejects.toSatisfy((error: unknown) => !String(error).includes("synthetic-refresh-value"));
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  test("synchronizes refreshed access, refresh, and last_refresh atomically", async () => {
    const fixture = await authorityFixture();
    try {
      await writeAuthority(fixture.authority);
      const refreshed = completeAuthority().replace("synthetic-access-value", "synthetic-access-refreshed")
        .replace("synthetic-refresh-value", "synthetic-refresh-refreshed")
        .replace("2026-07-29T10:00:00.000Z", "2026-07-29T10:01:00.000Z");
      await fixture.authority.synchronizeStaged({ docker: stagedDocker(Buffer.from(refreshed)), containerId: "synthetic-container", stagedAuthPath: "/tmp/exact-home/auth.json" });
      const stored = (await fixture.authority.read()).bytes.toString("utf8");
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
      const metadata = kind === "symlink" ? "symbolic link 600 9" : `regular file 600 ${staged.length}`;
      await expect(fixture.authority.synchronizeStaged({ docker: stagedDocker(staged, metadata), containerId: "synthetic-container", stagedAuthPath: "/tmp/exact-home/auth.json" })).rejects.toThrow();
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
