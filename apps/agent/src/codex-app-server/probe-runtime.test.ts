import { chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Duplex } from "node:stream";
import { afterEach, expect, test } from "vitest";
import type { DockerEngineClient } from "../docker-runtime.js";
import { resolveCodexExecutionArtifact, stageCodexExecutionArtifact } from "./artifact-identity.js";
import { architectureCompatible, createCodexProbeRuntime } from "./probe-runtime.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
});

function dockerFrame(payload: Uint8Array, stream = 1): Buffer {
  const header = Buffer.alloc(8);
  header[0] = stream;
  header.writeUInt32BE(payload.byteLength, 4);
  return Buffer.concat([header, Buffer.from(payload)]);
}

function tarEntry(name: string, bytes: Buffer): Buffer {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "utf8");
  header.write("0000644\0", 100, 8, "ascii");
  header.write("0000000\0", 108, 8, "ascii");
  header.write("0000000\0", 116, 8, "ascii");
  header.write(bytes.length.toString(8).padStart(11, "0") + "\0", 124, 12, "ascii");
  header.write("0000000\0", 136, 12, "ascii");
  header[156] = 0x30;
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  header.fill(0x20, 148, 156);
  let checksum = 0;
  for (const byte of header) checksum += byte;
  header.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");
  const padding = Buffer.alloc((512 - (bytes.length % 512)) % 512);
  return Buffer.concat([header, bytes, padding]);
}

function schemaArchive(): Buffer {
  return Buffer.concat([
    tarEntry("stable/ClientRequest.json", Buffer.from("{}")),
    tarEntry("experimental/ToolRequestUserInputParams.json", Buffer.from("{}")),
    tarEntry("experimental/v2/NewerSurface.json", Buffer.from("{}")),
    Buffer.alloc(1024)
  ]);
}

async function stagedFixture(): Promise<Awaited<ReturnType<typeof stageCodexExecutionArtifact>>> {
  const root = await mkdtemp(path.join(tmpdir(), "devspace-probe-artifact-")); roots.push(root);
  const state = await mkdtemp(path.join(tmpdir(), "devspace-probe-state-")); roots.push(state);
  const executable = path.join(root, "codex");
  await mkdir(path.dirname(executable), { recursive: true });
  await writeFile(executable, Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]), Buffer.alloc(64, 8)]), { mode: 0o755 });
  await chmod(executable, 0o755);
  const artifact = await resolveCodexExecutionArtifact(executable);
  return await stageCodexExecutionArtifact({ artifact, stateRoot: state });
}

function dockerFixture(expected: Awaited<ReturnType<typeof stagedFixture>>): { docker: DockerEngineClient; commands: string[][]; cleanup: string[] } {
  const commands: string[][] = [];
  const cleanup: string[] = [];
  let sequence = 0;
  const execInputs = new Map<string, { command: string[]; attachStdin: boolean }>();
  const docker = {
    inspectContainer: async (id: string) => id === "probe-container" ? ({
      Id: "probe-container", Name: "probe", Image: `sha256:${"a".repeat(64)}`,
      Config: { Labels: {}, WorkingDir: "/", User: "1000:1000", Entrypoint: ["/bin/sh", "-c"], Cmd: ["exec sleep 2147483647"] },
      State: { Running: false, Status: "created" }, HostConfig: {
        Privileged: false, PublishAllPorts: false, PidMode: "", IpcMode: "private", UTSMode: "", UsernsMode: "", CgroupnsMode: "private",
        NetworkMode: "none", PortBindings: {}, Devices: [], NanoCpus: 1_000_000_000, Memory: 2_147_483_648, PidsLimit: 64,
        CapAdd: [], CapDrop: ["ALL"], SecurityOpt: ["no-new-privileges:true"], AutoRemove: false, ReadonlyRootfs: true,
        RestartPolicy: { Name: "no", MaximumRetryCount: 0 }, Binds: [], Mounts: [], Tmpfs: {
          "/opt/devspace-codex-probe": "rw,nosuid,nodev,exec,size=1g", "/tmp/devspace-codex-home": "rw,nosuid,nodev,noexec,size=16m",
          "/tmp/devspace-codex-state": "rw,nosuid,nodev,noexec,size=16m"
        }, MemorySwap: 2_147_483_648
      }, NetworkSettings: { Networks: { none: { NetworkID: "fixture-none" } } }, Mounts: []
    }) : ({
      Id: "managed-container", Name: "managed", Image: `sha256:${"a".repeat(64)}`,
      Config: { Labels: {}, WorkingDir: "/workspace", User: "1000:1000", Entrypoint: ["/project/start"], Cmd: ["boot"] },
      State: { Running: true, Status: "running" }, HostConfig: {}, NetworkSettings: { Networks: {} }, Mounts: []
    }),
    inspectImage: async () => ({
      Id: `sha256:${"a".repeat(64)}`, Os: "linux", Architecture: "amd64",
      Config: { Entrypoint: ["/project/start"], Cmd: ["boot"] }
    }),
    createProbeContainer: async () => "probe-container",
    startContainer: async () => undefined,
    createExec: async (_containerId: string, input: { command: readonly string[]; attachStdin: boolean }) => {
      const id = `exec-${++sequence}`;
      const command = [...input.command];
      commands.push(command);
      execInputs.set(id, { command, attachStdin: input.attachStdin });
      return id;
    },
    startExecAttached: async (id: string) => {
      const stream = new Duplex({ read() { /* output is driven by the fixture */ }, write(_chunk, _encoding, callback) { callback(); } });
      const input = execInputs.get(id);
      if (input?.attachStdin === true) {
        stream.once("finish", () => setImmediate(() => stream.emit("close")));
      } else {
        setImmediate(() => {
          if (input?.command.includes("--version") === true) stream.push(dockerFrame(Buffer.from("codex-cli 0.153.4\n")));
          else if (input?.command[0] === "sha256sum") {
            const output = input.command.slice(2).map((file) => {
              const relative = file.slice("/opt/devspace-codex-probe/".length);
              const entry = expected.artifact.entries.find((candidate) => candidate.relativePath === relative);
              return `${entry?.sha256 ?? "0".repeat(64)}  ${file}\n`;
            }).join("");
            stream.push(dockerFrame(Buffer.from(output)));
          }
          else if (input?.command.some((part) => part.includes("tar")) === true) stream.push(dockerFrame(schemaArchive()));
          stream.emit("close");
        });
      }
      return stream;
    },
    inspectExec: async () => ({ ID: "exec", Running: false, ExitCode: 0, ContainerID: "probe-container" }),
    stopContainer: async () => { cleanup.push("stop"); },
    removeContainer: async () => { cleanup.push("remove"); }
  } as unknown as DockerEngineClient;
  return { docker, commands, cleanup };
}

test("probes the exact managed image with fixed commands and bounded schema output", async () => {
  const stagedArtifact = await stagedFixture();
  const fixture = dockerFixture(stagedArtifact);
  const runtime = createCodexProbeRuntime({ docker: fixture.docker, createId: () => "018f0f00-0000-7000-8000-000000000001" });

  const result = await runtime.probe({
    managedContainerId: "managed-container",
    stagedArtifact,
    workspaceContext: { ownership: { developmentContainer: { id: "managed-container" } } } as never
  });

  expect(result.runtime).toEqual({
    imageId: `sha256:${"a".repeat(64)}`, operatingSystem: "linux", architecture: "amd64", containerUser: "1000:1000",
    policyVersion: "codex-probe-runtime-v1"
  });
  expect(result.versionOutput).toBe("codex-cli 0.153.4");
  expect(result.schemaFiles.get("stable/ClientRequest.json")).toEqual(Buffer.from("{}"));
  expect(result.schemaFiles.get("experimental/ToolRequestUserInputParams.json")).toEqual(Buffer.from("{}"));
  expect(fixture.commands.some((command) => command.includes("--version"))).toBe(true);
  expect(fixture.commands.some((command) => command.includes("--experimental"))).toBe(true);
  expect(fixture.cleanup).toEqual(["stop", "remove"]);
});

test("matches the architecture component of an official Rust target triple", () => {
  expect(architectureCompatible("x86_64-unknown", "amd64")).toBe(true);
  expect(architectureCompatible("aarch64-unknown", "arm64")).toBe(true);
  expect(architectureCompatible("x86_64-unknown", "arm64")).toBe(false);
});
