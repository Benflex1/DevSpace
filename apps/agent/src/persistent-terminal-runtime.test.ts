import { describe, expect, test } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pipeline } from "node:stream/promises";
import { PassThrough } from "node:stream";
import * as tar from "tar-stream";
import {
  buildPersistentTmuxArchive,
  PersistentTmuxIdentityMismatchError,
  PersistentTmuxRuntime,
  persistentTerminalOwnershipMarker,
  persistentTmuxBinding,
  persistentTmuxSessionName,
  parseTmuxPaneObservation,
  type PersistentTerminalOwnership
} from "./persistent-terminal-runtime.js";
import type { DockerEngineClient } from "./docker-runtime.js";

const ownership: PersistentTerminalOwnership = {
  projectId: "018f0f00-0000-7000-8000-000000000001",
  workspaceId: "018f0f00-0000-7000-8000-000000000002",
  terminalId: "018f0f00-0000-7000-8000-000000000003",
  processId: "018f0f00-0000-7000-8000-000000000003",
  containerId: "a".repeat(64),
  generation: 1,
  revisionId: "018f0f00-0000-7000-8000-000000000004",
  revisionHash: `sha256-jcs-v1:${"b".repeat(64)}`,
  runtimePlanHash: `sha256-jcs-v1:${"c".repeat(64)}`
};

function multiplexedStdout(output: string): Buffer {
  const bytes = Buffer.from(output);
  const frame = Buffer.alloc(8 + bytes.length);
  frame[0] = 1;
  frame.writeUInt32BE(bytes.length, 4);
  bytes.copy(frame, 8);
  return frame;
}

function socketInspectionRuntime(socketMetadata: string): {
  readonly runtime: PersistentTmuxRuntime;
  readonly binding: ReturnType<typeof persistentTmuxBinding>;
} {
  const binding = persistentTmuxBinding(ownership.containerId, 1000, 1000);
  const commands = new Map<string, readonly string[]>();
  let nextExec = 0;
  const response = (command: readonly string[]) => {
    if (command.includes("stat")) return { exitCode: 0, stdout: `${socketMetadata}\n` };
    if (command.includes("list-panes")) {
      return { exitCode: 0, stdout: `${persistentTmuxSessionName(ownership.terminalId)}|$7|%0|4321|0|-1|1|1\n` };
    }
    if (command.includes("show-environment")) {
      return { exitCode: 0, stdout: `DEVSPACE_TERMINAL_OWNER=${persistentTerminalOwnershipMarker(ownership)}\n` };
    }
    return { exitCode: 0, stdout: "" };
  };
  const engine = {
    createExec: (_containerId: string, input: { readonly command: readonly string[] }): Promise<string> => {
      const execId = `socket-inspection-${++nextExec}`;
      commands.set(execId, input.command);
      return Promise.resolve(execId);
    },
    startExecAttached: (execId: string, tty: boolean): Promise<PassThrough> => {
      const stream = new PassThrough();
      const command = commands.get(execId) ?? [];
      queueMicrotask(() => {
        if (tty) stream.write(Buffer.from("tmux probe redraw"));
        else stream.end(multiplexedStdout(response(command).stdout));
      });
      return Promise.resolve(stream);
    },
    inspectExec: (execId: string) => Promise.resolve({ ID: execId, ContainerID: binding.containerId,
      Running: false, ExitCode: response(commands.get(execId) ?? []).exitCode })
  } as unknown as DockerEngineClient;
  return { runtime: new PersistentTmuxRuntime(engine), binding };
}

describe("persistent tmux identity", () => {
  test.each(["600", "670", "700"])('accepts a correctly owned tmux socket in secure mode %s', async (mode) => {
    const { runtime, binding } = socketInspectionRuntime(`socket ${mode} 1000:1000`);
    await expect(runtime.lookupSession(binding, ownership, persistentTmuxSessionName(ownership.terminalId), "$7", "%0"))
      .resolves.toMatchObject({ sessionId: "$7", paneId: "%0", panePid: 4321 });
  });

  test.each([
    "socket 700 1001:1000",
    "socket 700 1000:1001",
    "socket 701 1000:1000",
    "socket 770 1000:1000",
    "socket 755 1000:1000",
    "directory 700 1000:1000"
  ])("rejects unsafe tmux socket metadata %s", async (metadata) => {
    const { runtime, binding } = socketInspectionRuntime(metadata);
    await expect(runtime.lookupSession(binding, ownership, persistentTmuxSessionName(ownership.terminalId), "$7", "%0"))
      .rejects.toBeInstanceOf(PersistentTmuxIdentityMismatchError);
  });

  test("uses the same mode policy for the recovery capability probe", async () => {
    const { runtime, binding } = socketInspectionRuntime("socket 700 1000:1000");
    await expect(runtime.probe(binding)).resolves.toBeUndefined();
  });

  test("derives a deterministic session name and a runtime-fenced ownership marker", () => {
    expect(persistentTmuxSessionName(ownership.terminalId)).toBe(`ds-${ownership.terminalId}`);
    expect(persistentTerminalOwnershipMarker(ownership)).toMatch(/^[0-9a-f]{64}$/u);
    expect(persistentTerminalOwnershipMarker(ownership)).toBe(persistentTerminalOwnershipMarker({ ...ownership }));
    expect(persistentTerminalOwnershipMarker({ ...ownership, containerId: "d".repeat(64) }))
      .not.toBe(persistentTerminalOwnershipMarker(ownership));
    expect(persistentTerminalOwnershipMarker({ ...ownership, generation: 2 }))
      .not.toBe(persistentTerminalOwnershipMarker(ownership));
    const native = { ...ownership, harnessSessionId: "018f0f00-0000-7000-8000-000000000005",
      harnessGeneration: 8, harnessLeaseId: "lease-a" };
    expect(persistentTerminalOwnershipMarker({ ...native, harnessSessionId: "018f0f00-0000-7000-8000-000000000006" }))
      .not.toBe(persistentTerminalOwnershipMarker(native));
    expect(persistentTerminalOwnershipMarker({ ...native, harnessGeneration: 9 }))
      .not.toBe(persistentTerminalOwnershipMarker(native));
    expect(persistentTerminalOwnershipMarker({ ...native, harnessLeaseId: "lease-b" }))
      .not.toBe(persistentTerminalOwnershipMarker(native));
  });

  test("uses the existing root execution identity for an isolated tmux socket", () => {
    expect(persistentTmuxBinding("a".repeat(64), 0, 0)).toMatchObject({
      uid: 0,
      gid: 0,
      socketDirectory: "/tmp/devspace-persistent-tmux-0",
      socketPath: "/tmp/devspace-persistent-tmux-0/server.sock"
    });
  });

  test("packages tmux artifacts for a root-owned workspace execution identity", async () => {
    const headers: Array<{ readonly name: string; readonly uid?: number; readonly gid?: number; readonly mode?: number }> = [];
    const extract = tar.extract();
    extract.on("entry", (header, stream, next) => {
      headers.push({ name: header.name, uid: header.uid ?? -1, gid: header.gid ?? -1, mode: header.mode ?? -1 });
      stream.on("end", next);
      stream.resume();
    });
    await pipeline(await buildPersistentTmuxArchive(0, 0), extract);

    expect(headers.length).toBeGreaterThan(0);
    expect(headers.every((header) => header.uid === 0 && header.gid === 0)).toBe(true);
    expect(headers.every((header) => header.name !== "devspace-persistent-tmux-3.7c/exec-argv")).toBe(true);
  });

  test("launches Native argv and passes credentials only in the tmux session environment", async () => {
    const binding = persistentTmuxBinding(ownership.containerId, 1000, 1000);
    const created: Array<{ readonly command: readonly string[]; readonly environment: Readonly<Record<string, string>> }> = [];
    const commandByExec = new Map<string, readonly string[]>();
    let serverStarted = false;
    let bootstrapOwnerMarker = "";
    const engine = {
      createExec: (_containerId: string, input: { command: readonly string[]; environment: Readonly<Record<string, string>> }) => {
        created.push(input);
        const id = `create-native-${created.length}`;
        commandByExec.set(id, input.command);
        return Promise.resolve(id);
      },
      startExecAttached: (execId: string) => {
        const stream = new PassThrough();
        const command = commandByExec.get(execId) ?? [];
        if (command.includes("new-session")) serverStarted = true;
        const output = command.includes("stat") ? "socket 600 1000:1000\n"
          : command.includes("list-panes") ? `bootstrap-ds-${ownership.terminalId}|$1|%1|1234|0|-1|1|1\n`
            : command.includes("show-environment") ? `DEVSPACE_TERMINAL_OWNER=${bootstrapOwnerMarker}\n` : "";
        queueMicrotask(() => stream.end(multiplexedStdout(output)));
        return Promise.resolve(stream);
      },
      inspectExec: (execId: string) => Promise.resolve({ ID: execId, ContainerID: binding.containerId, Running: false,
        ExitCode: commandByExec.get(execId)?.includes("test") && !serverStarted ? 1 : 0 })
    } as unknown as DockerEngineClient;
    const runtime = new PersistentTmuxRuntime(engine);
    const nativeIdentity = { ...ownership, harnessSessionId: "018f0f00-0000-7000-8000-000000000005",
      harnessGeneration: 8, harnessLeaseId: "lease-a" };
    bootstrapOwnerMarker = persistentTerminalOwnershipMarker(nativeIdentity);
    await runtime.createSessionExec(binding, nativeIdentity, persistentTmuxSessionName(ownership.terminalId), {
      command: ["codex", "arg with spaces", "quote' ; echo unsafe"],
      environment: { CODEX_HOME: "/opt/devspace/private-home", PROVIDER_KEY: "credential-sentinel" }
    });

    const sessionExec = created.at(-1);
    const bootstrapExec = created.find((exec) => exec.command.includes("new-session"));
    expect(sessionExec).toBeDefined();
    expect(bootstrapExec).toBeDefined();
    expect(bootstrapExec!.command).toContain(`bootstrap-ds-${ownership.terminalId}`);
    expect(bootstrapExec!.environment).toEqual(binding.environment);
    expect(sessionExec!.environment).toMatchObject({
      ...binding.environment, CODEX_HOME: "/opt/devspace/private-home", PROVIDER_KEY: "credential-sentinel"
    });
    expect(JSON.stringify(sessionExec!.command)).not.toContain("credential-sentinel");
    expect(JSON.stringify(sessionExec!.command)).not.toContain("CODEX_HOME=/opt/devspace/private-home");
    expect(JSON.stringify(sessionExec!.command)).not.toContain("CODEX_HOME");
    expect(JSON.stringify(sessionExec!.command)).not.toContain("PROVIDER_KEY");
    expect(JSON.stringify(sessionExec!.command)).not.toContain("credential-sentinel");
    expect(sessionExec!.command.slice(-3)).toEqual(["codex", "arg with spaces", "quote' ; echo unsafe"]);
  });

  test("forwards only Native environment names through tmux session creation", async () => {
    const binding = persistentTmuxBinding(ownership.containerId, 1000, 1000);
    const commands: string[][] = [];
    let execId = 0;
    const engine = {
      createExec: (_containerId: string, input: { readonly command: readonly string[] }) => {
        commands.push([...input.command]);
        return Promise.resolve(`environment-${++execId}`);
      },
      startExecAttached: () => { const stream = new PassThrough(); queueMicrotask(() => stream.end(multiplexedStdout(""))); return Promise.resolve(stream); },
      inspectExec: (id: string) => Promise.resolve({ ID: id, ContainerID: binding.containerId, Running: false, ExitCode: 0 })
    } as unknown as DockerEngineClient;
    const runtime = new PersistentTmuxRuntime(engine);
    await runtime.setSessionEnvironmentForwarding(binding, ["CODEX_HOME", "PROVIDER_KEY"]);
    await runtime.setSessionEnvironmentForwarding(binding, []);
    expect(commands).toHaveLength(2);
    expect(commands[0]?.slice(-4)).toEqual(["set-option", "-g", "update-environment", "CODEX_HOME PROVIDER_KEY"]);
    expect(commands[1]?.slice(-4)).toEqual(["set-option", "-g", "update-environment", ""]);
    expect(JSON.stringify(commands)).not.toContain("credential-sentinel");
  });

  test("configures forwarding only after verifying the exact owned tmux socket", async () => {
    const binding = persistentTmuxBinding(ownership.containerId, 1000, 1000);
    const commands: string[][] = [];
    let execId = 0;
    const engine = {
      createExec: (_containerId: string, input: { readonly command: readonly string[] }) => {
        commands.push([...input.command]);
        return Promise.resolve(`configure-${++execId}`);
      },
      startExecAttached: () => {
        const stream = new PassThrough();
        const output = commands.at(-1)?.includes("stat") ? "socket 600 1000:1000\n" : "";
        queueMicrotask(() => stream.end(multiplexedStdout(output)));
        return Promise.resolve(stream);
      },
      inspectExec: (id: string) => Promise.resolve({ ID: id, ContainerID: binding.containerId, Running: false, ExitCode: 0 })
    } as unknown as DockerEngineClient;
    const runtime = new PersistentTmuxRuntime(engine);
    await expect(runtime.configureSessionEnvironmentForwarding(binding, ["PROVIDER_KEY"])).resolves.toBe(true);
    expect(commands).toHaveLength(3);
    expect(commands[0]?.slice(-3)).toEqual(["test", "-S", binding.socketPath]);
    expect(commands[1]?.slice(-3)).toEqual(["-c", "%F %a %u:%g", binding.socketPath]);
    expect(commands[2]?.slice(-4)).toEqual(["set-option", "-g", "update-environment", "PROVIDER_KEY"]);
    expect(JSON.stringify(commands)).not.toContain("credential-sentinel");
  });

  test("existing tmux servers forward only Native environment names and stop forwarding them afterward", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "devspace-tmux-env-test-"));
    const tmuxPath = fileURLToPath(new URL("../assets/tmux-3.7c", import.meta.url));
    const configPath = fileURLToPath(new URL("../assets/tmux.conf", import.meta.url));
    const socketPath = path.join(directory, "server.sock");
    const runTmux = (args: readonly string[], environment: NodeJS.ProcessEnv = process.env, config = configPath) => {
      const result = spawnSync(tmuxPath, ["-S", socketPath, "-f", config, ...args], {
        encoding: "utf8", env: { ...environment, TMUX_TMPDIR: directory }
      });
      if (result.error !== undefined) throw result.error;
      return result;
    };
    try {
      expect(runTmux(["new-session", "-d", "-s", "bootstrap", "-x", "80", "-y", "24", "-c", directory, "--",
        "/bin/sh -c 'sleep 30'"]).status).toBe(0);
      const forwarded = runTmux(["set-option", "-g", "update-environment", "PROVIDER_KEY"]);
      expect({ status: forwarded.status, stderr: forwarded.stderr }).toEqual({ status: 0, stderr: "" });
      expect(runTmux(["new-session", "-d", "-s", "native", "-x", "80", "-y", "24", "-c", directory,
        "-e", "DEVSPACE_TERMINAL_OWNER=owner-marker", "--", "/bin/sh -c 'sleep 30'"],
      { ...process.env, PROVIDER_KEY: "credential-sentinel" }).status).toBe(0);
      const nativeEnvironment = runTmux(["show-environment", "-t", "=native", "PROVIDER_KEY"]);
      expect(nativeEnvironment.status).toBe(0);
      expect(nativeEnvironment.stdout.trim()).toBe("PROVIDER_KEY=credential-sentinel");

      expect(runTmux(["set-environment", "-u", "-t", "=native", "PROVIDER_KEY"]).status).toBe(0);
      expect(runTmux(["set-environment", "-g", "-u", "PROVIDER_KEY"]).status).toBe(0);
      expect(runTmux(["set-option", "-g", "update-environment", ""]).status).toBe(0);
      expect(runTmux(["new-session", "-d", "-s", "shell", "-x", "80", "-y", "24", "-c", directory, "--", "/bin/sh -c 'sleep 30'"],
        { ...process.env, PROVIDER_KEY: "must-not-reach-shell" }).status).toBe(0);
      const shellEnvironment = runTmux(["show-environment", "-t", "=shell", "PROVIDER_KEY"]);
      expect(shellEnvironment.status).not.toBe(0);
      expect(shellEnvironment.stdout).not.toContain("must-not-reach-shell");
    } finally {
      runTmux(["kill-server"]);
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("a first Native tmux server starts clean and the Native session alone receives its environment", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "devspace-tmux-first-env-test-"));
    const tmuxPath = fileURLToPath(new URL("../assets/tmux-3.7c", import.meta.url));
    const configPath = fileURLToPath(new URL("../assets/tmux.conf", import.meta.url));
    const socketPath = path.join(directory, "server.sock");
    const runTmux = (args: readonly string[], environment: NodeJS.ProcessEnv = process.env, config = configPath) => {
      const result = spawnSync(tmuxPath, ["-S", socketPath, "-f", config, ...args], {
        encoding: "utf8", env: { ...environment, TMUX_TMPDIR: directory }
      });
      if (result.error !== undefined) throw result.error;
      return result;
    };
    const baseBinding = persistentTmuxBinding(ownership.containerId, process.getuid?.() ?? 1000, process.getgid?.() ?? 1000);
    const binding = { ...baseBinding, binaryPath: tmuxPath, configPath, socketDirectory: directory, socketPath,
      environment: { ...baseBinding.environment, TMUX_TMPDIR: directory } };
    const execCommands = new Map<string, readonly string[]>();
    const execEnvironments = new Map<string, Readonly<Record<string, string>>>();
    const execResults = new Map<string, ReturnType<typeof spawnSync>>();
    let nextExecId = 0;
    const engine = {
      createExec: (_containerId: string, input: { readonly command: readonly string[];
        readonly environment: Readonly<Record<string, string>> }) => {
        const execId = `first-native-${++nextExecId}`;
        execCommands.set(execId, input.command);
        execEnvironments.set(execId, input.environment);
        return Promise.resolve(execId);
      },
      startExecAttached: (execId: string) => {
        const args = [...(execCommands.get(execId) ?? [])];
        const workingDirectoryIndex = args.indexOf("-c");
        if (workingDirectoryIndex >= 0 && args[workingDirectoryIndex + 1] === "/workspace") {
          args[workingDirectoryIndex + 1] = directory;
        }
        const result = spawnSync(args[0] ?? "", args.slice(1), {
          encoding: "buffer", env: { ...execEnvironments.get(execId), TMUX_TMPDIR: directory }
        });
        if (result.error !== undefined) throw result.error;
        execResults.set(execId, result);
        const stream = new PassThrough();
        queueMicrotask(() => stream.end(multiplexedStdout(result.stdout.toString())));
        return Promise.resolve(stream);
      },
      inspectExec: (execId: string) => Promise.resolve({ ID: execId, ContainerID: ownership.containerId, Running: false,
        ExitCode: execResults.get(execId)?.status ?? 1 })
    } as unknown as DockerEngineClient;
    try {
      const injectionMarker = path.join(directory, "injection-marker");
      const argumentPayload = `literal' ; touch ${injectionMarker}; #`;
      const nativeCommand = ["/bin/sh", "-c",
        "if [ \"$PROVIDER_KEY\" = credential-sentinel ]; then echo NATIVE_ENV_OK; else echo NATIVE_ENV_MISSING; fi; printf 'ARG:%s\\n' \"$1\"; exec sleep 30",
        "sh", argumentPayload];
      const runtime = new PersistentTmuxRuntime(engine);
      const nativeIdentity = { ...ownership, harnessSessionId: "018f0f00-0000-7000-8000-000000000005",
        harnessGeneration: 8, harnessLeaseId: "lease-a" };
      const nativeExecId = await runtime.createSessionExec(binding, nativeIdentity, "native", {
        command: nativeCommand,
        environment: { CODEX_HOME: "/opt/devspace/private-home", PROVIDER_KEY: "credential-sentinel" }
      });
      expect(execEnvironments.get(nativeExecId)).toMatchObject({ PROVIDER_KEY: "credential-sentinel" });
      expect((await runtime.startCreatedExec(binding, nativeExecId)).exitCode).toBe(0);
      await new Promise((resolve) => setTimeout(resolve, 20));
      const nativeScreen = runTmux(["capture-pane", "-p", "-t", "=native:0.0"]);
      expect(nativeScreen.status).toBe(0);
      expect(nativeScreen.stdout).toContain("NATIVE_ENV_OK");
      expect(nativeScreen.stdout).toContain("ARG:literal' ; touch");
      expect(await readFile(injectionMarker).then(() => true, () => false)).toBe(false);
      expect(runTmux(["show-environment", "-t", "=native", "PROVIDER_KEY"]).stdout.trim())
        .toBe("PROVIDER_KEY=credential-sentinel");
      expect(runTmux(["show-environment", "-g", "PROVIDER_KEY"]).status).not.toBe(0);

      const serverProcesses = await readdir("/proc");
      const tmuxServerEnvironment = await Promise.all(serverProcesses.filter((pid) => /^[0-9]+$/u.test(pid)).map(async (pid) => {
        try {
          const commandLine = await readFile(path.join("/proc", pid, "cmdline"));
          if (!commandLine.includes(Buffer.from(socketPath))) return null;
          const processEnvironment = await readFile(path.join("/proc", pid, "environ"));
          return processEnvironment.includes(Buffer.from(`TMUX_TMPDIR=${directory}`))
            ? processEnvironment.toString("utf8") : null;
        } catch { return null; }
      }));
      const matchingServerEnvironment = tmuxServerEnvironment.find((environment) => environment !== null);
      expect(matchingServerEnvironment).toBeDefined();
      expect(matchingServerEnvironment).not.toContain("PROVIDER_KEY=credential-sentinel");

      await runtime.clearSessionEnvironment(binding, nativeIdentity, "native", ["CODEX_HOME", "PROVIDER_KEY"]);
      expect(runTmux(["show-environment", "-t", "=native", "PROVIDER_KEY"]).status).not.toBe(0);
      expect(runTmux(["show-environment", "-g", "PROVIDER_KEY"]).status).not.toBe(0);
      expect(runTmux(["list-sessions", "-F", "#{session_name}"]).stdout.trim().split("\n")).toEqual(["native"]);

      const shellCommand = ["/bin/sh", "-c",
        "if [ \"$PROVIDER_KEY\" = must-not-reach-shell ]; then echo SHELL_ENV_LEAK; else echo SHELL_ENV_CLEAN; fi; exec sleep 30"];
      expect(runTmux(["new-session", "-d", "-s", "shell", "-x", "80", "-y", "24", "-c", directory, "--", ...shellCommand],
        { ...process.env, PROVIDER_KEY: "must-not-reach-shell" }).status).toBe(0);
      await new Promise((resolve) => setTimeout(resolve, 20));
      const shellScreen = runTmux(["capture-pane", "-p", "-t", "=shell:0.0"]);
      expect(shellScreen.stdout).toContain("SHELL_ENV_CLEAN");
      expect(shellScreen.stdout).not.toContain("SHELL_ENV_LEAK");
      expect(runTmux(["show-environment", "-g", "PROVIDER_KEY"]).status).not.toBe(0);
    } finally {
      runTmux(["kill-server"]);
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("Native history controls expose retained conversation lines and return to the live screen", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "devspace-tmux-native-history-test-"));
    const tmuxPath = fileURLToPath(new URL("../assets/tmux-3.7c", import.meta.url));
    const configPath = fileURLToPath(new URL("../assets/tmux.conf", import.meta.url));
    const sessionName = "native-history";
    const socketPath = path.join(directory, "server.sock");
    const target = `=${sessionName}:0.0`;
    const runTmux = (args: readonly string[]) => {
      const result = spawnSync(tmuxPath, ["-S", socketPath, "-f", configPath, ...args], {
        encoding: "utf8", env: { ...process.env, TMUX_TMPDIR: directory }
      });
      if (result.error !== undefined) throw result.error;
      return result;
    };
    const historyCommand = ["/bin/sh", "-c", "printf 'EARLIER_CONVERSATION_MARKER\\n'; i=1; while [ $i -le 40 ]; do printf 'CONVERSATION_LINE_%s\\n' \"$i\"; i=$((i+1)); done; printf 'CURRENT_CONVERSATION_SCREEN\\n'; exec sleep 30"];
    const created = runTmux(["new-session", "-d", "-s", sessionName, "-x", "80", "-y", "24", "-c", directory,
      "--", ...historyCommand]);
    expect({ status: created.status, stderr: created.stderr }).toEqual({ status: 0, stderr: "" });
    const binding = {
      ...persistentTmuxBinding(ownership.containerId, 1000, 1000), binaryPath: tmuxPath, configPath,
      socketDirectory: directory, socketPath
    };
    let nextExecId = 0;
    const commands = new Map<string, readonly string[]>();
    const results = new Map<string, ReturnType<typeof spawnSync>>();
    const engine = {
      createExec: (_containerId: string, input: { readonly command: readonly string[] }) => {
        const execId = `native-history-${++nextExecId}`;
        commands.set(execId, input.command);
        return Promise.resolve(execId);
      },
      startExecAttached: (execId: string) => {
        const command = commands.get(execId) ?? [];
        const result = spawnSync(command[0] ?? "", command.slice(1), {
          encoding: "buffer", env: { ...process.env, TMUX_TMPDIR: directory }
        });
        if (result.error !== undefined) throw result.error;
        results.set(execId, result);
        const stream = new PassThrough();
        queueMicrotask(() => stream.end(multiplexedStdout(result.stdout.toString())));
        return Promise.resolve(stream);
      },
      inspectExec: (execId: string) => Promise.resolve({ ID: execId, ContainerID: ownership.containerId, Running: false,
        ExitCode: results.get(execId)?.status ?? 1 })
    } as unknown as DockerEngineClient;
    try {
      const currentScreen = runTmux(["capture-pane", "-p", "-t", target]);
      expect(currentScreen.stdout).toContain("CURRENT_CONVERSATION_SCREEN");
      expect(currentScreen.stdout).not.toContain("EARLIER_CONVERSATION_MARKER");

      const runtime = new PersistentTmuxRuntime(engine);
      await runtime.history(binding, sessionName);
      expect(runTmux(["display-message", "-p", "-t", target, "#{pane_in_mode}"]).stdout.trim()).toBe("1");
      const scrollBefore = Number(runTmux(["display-message", "-p", "-t", target, "#{scroll_position}"]).stdout.trim());
      const moved = runTmux(["send-keys", "-X", "-N", "60", "-t", target, "cursor-up"]);
      expect({ status: moved.status, stderr: moved.stderr }).toEqual({ status: 0, stderr: "" });
      const scrollAfter = Number(runTmux(["display-message", "-p", "-t", target, "#{scroll_position}"]).stdout.trim());
      expect(scrollAfter).toBeGreaterThan(scrollBefore);
      const retainedHistory = runTmux(["capture-pane", "-p", "-S", "-", "-t", target]);
      expect(retainedHistory.stdout).toContain("EARLIER_CONVERSATION_MARKER");
      expect(retainedHistory.stdout).toContain("CURRENT_CONVERSATION_SCREEN");

      await runtime.live(binding, sessionName);
      expect(runTmux(["display-message", "-p", "-t", target, "#{pane_in_mode}"]).stdout.trim()).toBe("0");
      expect(runTmux(["capture-pane", "-p", "-t", target]).stdout).toContain("CURRENT_CONVERSATION_SCREEN");
    } finally {
      runTmux(["kill-server"]);
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("removes only named session variables through the exact tmux session target", async () => {
    const binding = persistentTmuxBinding(ownership.containerId, 1000, 1000);
    const commands: string[][] = [];
    let execId = 0;
    const engine = {
      createExec: (_containerId: string, input: { readonly command: readonly string[] }) => {
        commands.push([...input.command]);
        return Promise.resolve(`cleanup-${++execId}`);
      },
      startExecAttached: () => {
        const stream = new PassThrough();
        const output = commands.at(-1)?.includes("stat") ? "socket 600 1000:1000\n" : "";
        queueMicrotask(() => stream.end(multiplexedStdout(output)));
        return Promise.resolve(stream);
      },
      inspectExec: (id: string) => Promise.resolve({ ID: id, ContainerID: binding.containerId, Running: false, ExitCode: 0 })
    } as unknown as DockerEngineClient;
    const runtime = new PersistentTmuxRuntime(engine);
    await runtime.clearSessionEnvironment(binding, ownership, "ds-native", ["CODEX_HOME", "PROVIDER_KEY"]);
    expect(commands).toHaveLength(10);
    expect(commands[0]?.slice(-3)).toEqual(["test", "-S", binding.socketPath]);
    expect(commands[1]?.slice(-3)).toEqual(["-c", "%F %a %u:%g", binding.socketPath]);
    expect(commands[2]?.slice(-5)).toEqual(["set-environment", "-u", "-t", "=ds-native", "CODEX_HOME"]);
    expect(commands[3]?.slice(-4)).toEqual(["set-environment", "-g", "-u", "CODEX_HOME"]);
    expect(commands[4]?.slice(-5)).toEqual(["set-environment", "-u", "-t", "=ds-native", "PROVIDER_KEY"]);
    expect(commands[5]?.slice(-4)).toEqual(["set-environment", "-g", "-u", "PROVIDER_KEY"]);
    expect(commands[6]?.slice(-4)).toEqual(["set-option", "-g", "update-environment", ""]);
    expect(commands[7]?.slice(-3)).toEqual(["test", "-e", binding.socketPath]);
    expect(commands[9]?.slice(-4)).toEqual(["list-panes", "-a", "-F", expect.any(String)]);
  });

  test("parses one exact pane and retains pane-death evidence", () => {
    expect(parseTmuxPaneObservation("ds-shell|$4|%7|1234|0|-1|1|1\n")).toEqual({
      sessionName: "ds-shell", sessionId: "$4", paneId: "%7", panePid: 1234,
      paneDead: false, paneDeadStatus: null
    });
    expect(parseTmuxPaneObservation("ds-shell|$4|%7|1234|1|7|1|1\n")).toEqual({
      sessionName: "ds-shell", sessionId: "$4", paneId: "%7", panePid: 1234,
      paneDead: true, paneDeadStatus: 7
    });
  });

  test.each([
    "",
    "ds-shell|$4|%7|1234|0|-1|2|1",
    "ds-shell|$4|%7|1234|0|-1|1|2",
    "ds-shell|$4|%7|bad|0|-1|1|1",
    "ds-shell|$4|%7|1234|false|-1|1|1",
    "ds-shell|$4|%7|1234|1|not-an-exit|1|1"
  ])("rejects incomplete or multi-pane tmux identity %j", (output) => {
    expect(parseTmuxPaneObservation(output)).toBeNull();
  });
});
