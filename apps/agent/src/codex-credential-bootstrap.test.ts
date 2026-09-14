import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import path from "node:path";
import { Duplex } from "node:stream";
import { describe, expect, test } from "vitest";
import { bootstrapCodexCredential, buildCodexBootstrapContainerInput, codexBootstrapArchitectureCompatible } from "./codex-credential-bootstrap.js";
import { createCodexCredentialAuthority } from "./codex-credential-authority.js";
import { DockerEngineClient } from "./docker-runtime.js";

const completeAuthority = JSON.stringify({
  auth_mode: "chatgpt",
  OPENAI_API_KEY: null,
  tokens: {
    id_token: `${Buffer.from('{"alg":"none"}').toString("base64url")}.${Buffer.from('{"sub":"test"}').toString("base64url")}.signature`,
    access_token: "access-token",
    refresh_token: "refresh-token"
  },
  last_refresh: "2026-07-29T10:00:00.000Z"
});

function writeU64(value: bigint): Buffer {
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64BE(value);
  return bytes;
}

function stagedReadbackFrame(bytes: Buffer): Buffer {
  const uid = 1000n;
  const snapshot = [7n, 42n, BigInt(bytes.length), 0o100600n, uid, 1n, uid].map(writeU64);
  const metadata = Buffer.concat([...snapshot, ...snapshot]);
  const header = Buffer.alloc(20);
  Buffer.from("DSAUTH01", "ascii").copy(header, 0);
  header.writeUInt32BE(1, 8);
  header.writeUInt32BE(metadata.length, 12);
  header.writeUInt32BE(bytes.length, 16);
  return Buffer.concat([header, metadata, bytes]);
}

function dockerFrame(bytes: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header[0] = 1;
  header.writeUInt32BE(bytes.length, 4);
  return Buffer.concat([header, bytes]);
}

function bootstrapDockerFixture(options: { readonly loginCompletes: boolean }) {
  const imageId = `sha256:${"c".repeat(64)}`;
  let containerInput: ReturnType<typeof buildCodexBootstrapContainerInput> | null = null;
  let execNumber = 0;
  const createdExecs: string[] = [];
  const createExecKinds: string[] = [];
  const docker = {
    ensureImage: () => Promise.resolve(),
    inspectImage: () => Promise.resolve({ Id: imageId, Os: "linux", Architecture: "amd64", Config: {} }),
    createCodexBootstrapContainer: (_name: string, input: Parameters<DockerEngineClient["createCodexBootstrapContainer"]>[1]) => {
      containerInput = buildCodexBootstrapContainerInput(input);
      return Promise.resolve("bootstrap-container");
    },
    inspectContainer: () => {
      if (containerInput === null) throw new Error("container-not-created");
      const host = containerInput.HostConfig;
      return Promise.resolve({
        Id: "bootstrap-container", Name: "/devspace-codex-bootstrap-test", Image: imageId,
        Config: { Labels: containerInput.Labels, Image: imageId, WorkingDir: "/", User: "", Entrypoint: containerInput.Entrypoint, Cmd: containerInput.Cmd },
        State: { Running: true, Status: "running" }, HostConfig: host,
        NetworkSettings: { Networks: {} },
        Mounts: host.Mounts.map((mount) => ({ Type: mount.Type, Source: mount.Source, Destination: mount.Target, RW: !mount.ReadOnly, Propagation: mount.BindOptions?.Propagation ?? "" }))
      });
    },
    startContainer: () => Promise.resolve(),
    stopContainer: () => Promise.resolve(),
    removeContainer: () => Promise.resolve(),
    createExec: (_containerId: string, input: Parameters<DockerEngineClient["createExec"]>[1]) => {
      const command = input.command.join(" ");
      const kind = command.includes("app-server") ? "login" : input.command.length === 1 && input.command[0] === "/opt/codex-home/.devspace-staged-readback" ? "readback" : "upload";
      const id = `bootstrap-exec-${++execNumber}`;
      createdExecs.push(id);
      createExecKinds.push(kind);
      return Promise.resolve(id);
    },
    startExecAttached: (execId: string) => {
      const kind = createExecKinds[Number(execId.slice("bootstrap-exec-".length)) - 1];
      if (kind === "readback") {
        const stream = new Duplex({ read() { /* output is emitted below */ }, write(_chunk, _encoding, callback) { callback(); } });
        process.nextTick(() => {
          stream.push(dockerFrame(stagedReadbackFrame(Buffer.from(completeAuthority))));
          setImmediate(() => stream.emit("close"));
        });
        return Promise.resolve(stream);
      }
      if (kind === "upload") {
        const stream = new Duplex({ read() { /* no output */ }, write(_chunk, _encoding, callback) { callback(); } });
        process.nextTick(() => stream.emit("close"));
        return Promise.resolve(stream);
      }
      let lineBuffer = "";
      const stream = new Duplex({
        read() { /* app-server output is pushed in response to JSON-RPC */ },
        write(chunk, _encoding, callback) {
          lineBuffer += Buffer.from(chunk).toString("utf8");
          for (let newline = lineBuffer.indexOf("\n"); newline >= 0; newline = lineBuffer.indexOf("\n")) {
            const line = lineBuffer.slice(0, newline);
            lineBuffer = lineBuffer.slice(newline + 1);
            if (line.length === 0) continue;
            const request = JSON.parse(line) as { id?: number; method?: string };
            if (request.id === undefined) continue;
            const result = request.method === "account/login/start"
              ? { verificationUrl: "https://auth.example.test/device", userCode: "TEST-CODE" }
              : {};
            process.nextTick(() => {
              stream.push(dockerFrame(Buffer.from(`${JSON.stringify({ id: request.id, result })}\n`, "utf8")));
              if (request.method === "account/login/start" && options.loginCompletes) {
                stream.push(dockerFrame(Buffer.from(`${JSON.stringify({ method: "account/login/completed", params: { success: true } })}\n`, "utf8")));
              }
            });
          }
          callback();
        }
      });
      return Promise.resolve(stream);
    },
    inspectExec: (execId: string) => Promise.resolve({ ID: execId, Running: false, ExitCode: 0, ContainerID: "bootstrap-container" })
  } as unknown as DockerEngineClient;
  return { docker, imageId, createdExecs, createExecKinds };
}

describe("Codex credential bootstrap", () => {
  test("builds an isolated rootless authentication container without unrelated authority", () => {
    const imageId = `sha256:${"a".repeat(64)}`;
    const input = buildCodexBootstrapContainerInput({
      imageId,
      artifactRoot: "/agent-private/staging/codex",
      codexHomePath: "/agent-private/bootstrap-home",
      labels: { "devspace.private-purpose": "codex-credential-bootstrap" },
      cpuMillicores: 1_000,
      memoryBytes: 512 * 1024 * 1024,
      pidLimit: 128
    });

    expect(input.Image).toBe(imageId);
    expect(input.HostConfig.Mounts).toEqual([
      {
        Type: "bind", Source: "/agent-private/staging/codex", Target: "/opt/codex",
        ReadOnly: true, BindOptions: { Propagation: "rprivate" }
      },
      {
        Type: "bind", Source: "/agent-private/bootstrap-home", Target: "/opt/codex-home",
        ReadOnly: false, BindOptions: { Propagation: "rprivate" }
      }
    ]);
    expect(input.HostConfig.NetworkMode).toBe("bridge");
    expect(input.HostConfig.Privileged).toBe(false);
    expect(input.HostConfig.CapDrop).toEqual(["ALL"]);
    expect(input.HostConfig.SecurityOpt).toEqual(["no-new-privileges:true"]);
    expect(input.HostConfig.PortBindings).toEqual({});
    expect(input).not.toHaveProperty("/workspace");
    expect(JSON.stringify(input)).not.toContain(".codex");
    expect(JSON.stringify(input)).not.toContain("docker.sock");
    expect(JSON.stringify(input)).not.toContain("agent.sock");
  });

  test("refuses to overwrite an existing authority unless reauthentication is explicit", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "devspace-codex-bootstrap-test-"));
    const authority = createCodexCredentialAuthority(root);
    const docker = new DockerEngineClient(path.join(root, "unused.sock"));
    let dockerCalls = 0;
    Object.assign(docker, {
      ensureImage: () => { dockerCalls += 1; return Promise.resolve(); }
    });
    try {
      await mkdir(authority.authorityDir, { recursive: true, mode: 0o700 });
      await writeFile(authority.authPath, completeAuthority, { mode: 0o600 });
      await expect(bootstrapCodexCredential({
        stateRoot: root, configuredCodexPath: "/never-read", docker, createId: () => "bootstrap-test",
        onDeviceCode: () => undefined
      })).rejects.toThrow("authority-exists-use-reauth");
      expect(dockerCalls).toBe(0);
      await expect(authority.read()).resolves.toMatchObject({ bytes: Buffer.from(completeAuthority) });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("does not contain a host Codex-home copy or provider bypass", async () => {
    const source = await readFile(new URL("./codex-credential-bootstrap.ts", import.meta.url), "utf8");
    expect(source).not.toContain("~/.codex");
    expect(source).not.toContain("execFile");
    expect(source).not.toContain("child_process");
  });

  test("admits the supported x86_64-linux target spelling and rejects arm64", () => {
    expect(codexBootstrapArchitectureCompatible({ os: "linux", architecture: "x86_64-unknown" }, "amd64")).toBe(true);
    expect(codexBootstrapArchitectureCompatible({ os: "linux", architecture: "aarch64-unknown" }, "amd64")).toBe(false);
    expect(codexBootstrapArchitectureCompatible({ os: "darwin", architecture: "x86_64" }, "amd64")).toBe(false);
  });

  test("writes a completed device login through the Agent authority and cleans all attempt state", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "devspace-codex-bootstrap-success-"));
    const fixture = bootstrapDockerFixture({ loginCompletes: true });
    const deviceCodes: Array<{ verificationUrl: string; userCode: string }> = [];
    try {
      const result = await bootstrapCodexCredential({
        stateRoot: root, configuredCodexPath: "/bin/true", docker: fixture.docker, createId: () => "bootstrap-success",
        helperPath: fileURLToPath(new URL("../native/artifacts/linux-x64/codex-staged-readback", import.meta.url)),
        loginTimeoutMs: 2_000, onDeviceCode: (details) => { deviceCodes.push(details); }
      });
      const authority = createCodexCredentialAuthority(root);
      await expect(authority.read()).resolves.toMatchObject({ bytes: Buffer.from(completeAuthority) });
      await expect(authority.inspect()).resolves.toBeUndefined();
      expect(result.imageId).toBe(fixture.imageId);
      expect(result.helperSha256).toMatch(/^[0-9a-f]{64}$/u);
      expect(deviceCodes).toEqual([{ verificationUrl: "https://auth.example.test/device", userCode: "TEST-CODE" }]);
      expect(fixture.createExecKinds).toContain("login");
      expect(fixture.createExecKinds.filter((kind) => kind === "readback")).toHaveLength(3);
      expect(await readdir(root)).toEqual(["codex-artifacts", "codex-auth"]);
      expect(await readdir(path.join(root, "codex-artifacts"))).toEqual([]);
      expect(await readdir(path.join(root, "codex-auth", "codex"))).toEqual(["auth.json"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("preserves an existing authority and releases the lease when reauthentication is cancelled", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "devspace-codex-bootstrap-cancel-"));
    const authority = createCodexCredentialAuthority(root);
    const fixture = bootstrapDockerFixture({ loginCompletes: false });
    try {
      await mkdir(authority.authorityDir, { recursive: true, mode: 0o700 });
      await writeFile(authority.authPath, completeAuthority, { mode: 0o600 });
      await expect(bootstrapCodexCredential({
        stateRoot: root, configuredCodexPath: "/bin/true", docker: fixture.docker, createId: () => "bootstrap-cancel",
        helperPath: fileURLToPath(new URL("../native/artifacts/linux-x64/codex-staged-readback", import.meta.url)),
        reauthenticate: true, loginTimeoutMs: 25, onDeviceCode: () => { throw new Error("operator-cancelled"); }
      })).rejects.toThrow("operator-cancelled");
      await expect(authority.read()).resolves.toMatchObject({ bytes: Buffer.from(completeAuthority) });
      await expect(authority.inspect()).resolves.toBeUndefined();
      expect(await readdir(root)).toEqual(["codex-artifacts", "codex-auth"]);
      expect(await readdir(path.join(root, "codex-artifacts"))).toEqual([]);
      expect(await readdir(authority.authorityDir)).toEqual(["auth.json"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
