import { unlink } from "node:fs/promises";
import http from "node:http";

function send(response, status, body = undefined) {
  const encoded = body === undefined ? "" : JSON.stringify(body);
  response.writeHead(status, encoded === "" ? {} : { "content-type": "application/json", "content-length": Buffer.byteLength(encoded) });
  response.end(encoded);
}
async function jsonBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export async function createDockerEngineFixture(socketPath, managedWorkspaceRoot) {
  const networks = new Map();
  const containers = new Map();
  const names = new Map();
  const lifecycles = new Map();
  const execs = new Map();
  const execSockets = new Map();
  let containerCreateFailures = 0;
  let counter = 0;
  const id = (prefix) => `${prefix}${String(++counter).padStart(63, "0")}`;
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://docker.local");
      if (request.method === "GET" && url.pathname === "/_ping") { response.writeHead(200).end("OK"); return; }
      if (request.method === "GET" && url.pathname === "/info") { send(response, 200, { SecurityOptions: ["name=rootless"] }); return; }
      if (request.method === "GET" && url.pathname.startsWith("/images/") && url.pathname.endsWith("/json")) { send(response, 200, { Id: "sha256:image" }); return; }
      if (request.method === "POST" && url.pathname === "/images/create") { response.writeHead(200).end('{"status":"done"}\n'); return; }
      if (request.method === "POST" && url.pathname === "/networks/create") {
        const body = await jsonBody(request);
        if (typeof body.Name !== "string" || names.has(body.Name) || body.Driver !== "bridge"
          || body.Labels?.["devspace.managed"] !== "true" || body.Labels?.["devspace.resource-role"] !== "network") {
          send(response, 409, { message: "invalid or colliding network" }); return;
        }
        const networkId = id("n");
        const network = { Id: networkId, Name: body.Name, Labels: body.Labels };
        networks.set(networkId, network); names.set(body.Name, networkId); send(response, 201, { Id: networkId }); return;
      }
      const networkMatch = /^\/networks\/([^/]+)$/u.exec(url.pathname);
      if (request.method === "GET" && networkMatch !== null) {
        const network = networks.get(decodeURIComponent(networkMatch[1]));
        if (network === undefined) send(response, 404, { message: "not found" }); else send(response, 200, network); return;
      }
      if (request.method === "POST" && url.pathname === "/containers/create") {
        const body = await jsonBody(request); const name = url.searchParams.get("name");
        const mount = body.HostConfig?.Mounts?.[0];
        const valid = typeof name === "string" && !names.has(name) && body.WorkingDir === "/workspace"
          && Array.isArray(body.Cmd) && body.Cmd[0] === "sh" && body.HostConfig?.Privileged === false
          && body.HostConfig?.PublishAllPorts === false && Object.keys(body.HostConfig?.PortBindings ?? {}).length === 0
          && body.HostConfig?.PidMode === "" && body.HostConfig?.NetworkMode?.startsWith("devspace-")
          && body.HostConfig?.IpcMode === "private"
          && body.HostConfig?.UTSMode === "" && body.HostConfig?.UsernsMode === "" && body.HostConfig?.CgroupnsMode === "private"
          && Array.isArray(body.HostConfig?.CapAdd) && body.HostConfig.CapAdd.length === 0
          && Array.isArray(body.HostConfig?.CapDrop) && body.HostConfig.CapDrop.length === 0
          && Array.isArray(body.HostConfig?.SecurityOpt) && body.HostConfig.SecurityOpt.length === 1
          && body.HostConfig?.AutoRemove === false && body.HostConfig?.ReadonlyRootfs === false
          && body.HostConfig?.RestartPolicy?.Name === "no" && body.HostConfig?.RestartPolicy?.MaximumRetryCount === 0
          && /^no-new-privileges[=:]true$/u.test(body.HostConfig.SecurityOpt[0])
          && Array.isArray(body.HostConfig?.Devices) && body.HostConfig.Devices.length === 0
          && mount?.Type === "bind" && mount.Target === "/workspace" && mount.ReadOnly === false
          && typeof mount.Source === "string" && mount.Source.startsWith(`${managedWorkspaceRoot}/`)
          && !JSON.stringify(body).includes("docker.sock")
          && Number.isSafeInteger(body.HostConfig?.NanoCpus) && body.HostConfig.NanoCpus > 0
          && Number.isSafeInteger(body.HostConfig?.Memory) && body.HostConfig.Memory > 0
          && Number.isSafeInteger(body.HostConfig?.PidsLimit) && body.HostConfig.PidsLimit > 0
          && body.Labels?.["devspace.managed"] === "true" && body.Labels?.["devspace.resource-role"] === "development-container";
        if (!valid) { send(response, 400, { message: "unsafe container request" }); return; }
        const networkId = names.get(body.HostConfig.NetworkMode);
        if (typeof networkId !== "string" || !networks.has(networkId)) { send(response, 400, { message: "unknown workspace network" }); return; }
        if (containerCreateFailures > 0) {
          containerCreateFailures -= 1; send(response, 500, { message: "fixture container creation failure" }); return;
        }
        const containerId = id("c");
        const container = { Id: containerId, Name: `/${name}`, Config: { Labels: body.Labels, WorkingDir: body.WorkingDir },
          HostConfig: { Privileged: body.HostConfig.Privileged, PublishAllPorts: body.HostConfig.PublishAllPorts,
            PidMode: body.HostConfig.PidMode, IpcMode: body.HostConfig.IpcMode, UTSMode: body.HostConfig.UTSMode,
            UsernsMode: body.HostConfig.UsernsMode, CgroupnsMode: body.HostConfig.CgroupnsMode,
            NetworkMode: body.HostConfig.NetworkMode,
            PortBindings: body.HostConfig.PortBindings, Devices: body.HostConfig.Devices,
            NanoCpus: body.HostConfig.NanoCpus, Memory: body.HostConfig.Memory, PidsLimit: body.HostConfig.PidsLimit,
            CapAdd: [...body.HostConfig.CapAdd], CapDrop: [...body.HostConfig.CapDrop], SecurityOpt: [...body.HostConfig.SecurityOpt],
            AutoRemove: body.HostConfig.AutoRemove, ReadonlyRootfs: body.HostConfig.ReadonlyRootfs,
            RestartPolicy: { ...body.HostConfig.RestartPolicy } },
          NetworkSettings: { Networks: { [body.HostConfig.NetworkMode]: { NetworkID: "" } } },
          Mounts: [{ Type: "bind", Source: mount.Source, Destination: mount.Target, RW: !mount.ReadOnly,
            Propagation: mount.BindOptions?.Propagation ?? "rprivate" }],
          State: { Running: false, Status: "created" } };
        containers.set(containerId, container); names.set(name, containerId); send(response, 201, { Id: containerId, Warnings: [] }); return;
      }
      const containerExecMatch = /^\/containers\/([^/]+)\/exec$/u.exec(url.pathname);
      if (request.method === "POST" && containerExecMatch !== null) {
        const container = containers.get(decodeURIComponent(containerExecMatch[1]));
        const body = await jsonBody(request);
        const valid = container?.State.Running === true && Array.isArray(body.Cmd) && body.Cmd.length > 0
          && body.Cmd.every((item) => typeof item === "string") && body.WorkingDir?.startsWith("/workspace")
          && !body.WorkingDir.includes("..") && Array.isArray(body.Env)
          && body.AttachStdout === true && body.AttachStderr === true && typeof body.Tty === "boolean";
        if (!valid) { send(response, 400, { message: "unsafe exec request" }); return; }
        const execId = id("e");
        // Docker's ExecInspectResponse uses a nullable ExitCode. A created exec
        // has no exit evidence until its exact start attempt produces an outcome.
        execs.set(execId, { ID: execId, Running: false, ExitCode: null,
          ContainerID: container.Id, command: [...body.Cmd], workingDirectory: body.WorkingDir,
          environment: [...body.Env], tty: body.Tty, rows: 24, columns: 80, input: "" });
        send(response, 201, { Id: execId }); return;
      }
      const execInspectMatch = /^\/exec\/([^/]+)\/json$/u.exec(url.pathname);
      if (request.method === "GET" && execInspectMatch !== null) {
        const execution = execs.get(decodeURIComponent(execInspectMatch[1]));
        if (execution === undefined) send(response, 404, { message: "not found" }); else send(response, 200, execution); return;
      }
      const execResizeMatch = /^\/exec\/([^/]+)\/resize$/u.exec(url.pathname);
      if (request.method === "POST" && execResizeMatch !== null) {
        const execution = execs.get(decodeURIComponent(execResizeMatch[1]));
        const rows = Number(url.searchParams.get("h")); const columns = Number(url.searchParams.get("w"));
        if (execution === undefined) { send(response, 404, { message: "not found" }); return; }
        if (!Number.isInteger(rows) || rows < 1 || !Number.isInteger(columns) || columns < 1) { send(response, 400, { message: "invalid resize" }); return; }
        execution.rows = rows; execution.columns = columns; response.writeHead(200).end(); return;
      }
      const containerMatch = /^\/containers\/([^/]+)(?:\/(json|start|stop))?$/u.exec(url.pathname);
      if (containerMatch !== null) {
        const container = containers.get(decodeURIComponent(containerMatch[1]));
        if (container === undefined) { send(response, 404, { message: "not found" }); return; }
        if (request.method === "GET" && containerMatch[2] === "json") {
          if (container.State.Running) {
            const lifecycle = lifecycles.get(container.Id);
            if (lifecycle !== undefined) {
              lifecycle.inspections += 1;
              if (lifecycle.unavailableAt === lifecycle.inspections) {
                containers.delete(container.Id); send(response, 404, { message: "fixture container unavailable" }); return;
              }
              if (lifecycle.driftAt === lifecycle.inspections && lifecycle.drift !== undefined) lifecycle.drift(container);
              if (lifecycle.exitAt === lifecycle.inspections) container.State = { Running: false, Status: "exited" };
            }
          }
          send(response, 200, container); return;
        }
        if (request.method === "POST" && containerMatch[2] === "start") {
          if (container.State.Running) { response.writeHead(304).end(); return; }
          const networkId = names.get(container.HostConfig.NetworkMode);
          if (typeof networkId !== "string" || !networks.has(networkId)) {
            send(response, 409, { message: "configured workspace network is unavailable" }); return;
          }
          container.NetworkSettings.Networks = { [container.HostConfig.NetworkMode]: { NetworkID: networkId } };
          container.State = { Running: true, Status: "running" }; response.writeHead(204).end(); return;
        }
        if (request.method === "POST" && containerMatch[2] === "stop") {
          if (!container.State.Running) { response.writeHead(304).end(); return; }
          container.State = { Running: false, Status: "exited" }; response.writeHead(204).end(); return;
        }
      }
      send(response, 404, { message: "unsupported fixture endpoint" });
    } catch (error) { send(response, 500, { message: error instanceof Error ? error.message : "fixture failure" }); }
  });
  server.on("upgrade", (request, socket, head) => {
    const match = /^\/exec\/([^/]+)\/start$/u.exec(new URL(request.url ?? "/", "http://docker.local").pathname);
    if (request.method !== "POST" || match === null || request.headers.upgrade !== "tcp") { socket.destroy(); return; }
    const execution = execs.get(decodeURIComponent(match[1]));
    if (execution === undefined) { socket.end("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n"); return; }
    const contentLength = Number(request.headers["content-length"] ?? 0); let body = Buffer.from(head);
    const start = () => {
      try {
        const options = JSON.parse(body.subarray(0, contentLength).toString("utf8"));
        if (options.Detach !== false || options.Tty !== execution.tty) throw new Error("invalid start options");
      } catch { socket.end("HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n"); return; }
      execution.Running = true; execution.ExitCode = null; execSockets.set(execution.ID, socket);
      socket.write("HTTP/1.1 101 UPGRADED\r\nContent-Type: application/vnd.docker.raw-stream\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n");
      const command = execution.command;
      const executable = command[0]; const args = command.slice(1);
      if (executable === "/bin/sh" && execution.tty) {
        socket.write("/workspace $ ");
        socket.on("data", (chunk) => {
          execution.input += chunk.toString("utf8").replace(/\r\n?/gu, "\n");
          let newline;
          while ((newline = execution.input.indexOf("\n")) >= 0) {
            const line = execution.input.slice(0, newline).replace(/\r$/u, ""); execution.input = execution.input.slice(newline + 1);
            if (line === "pwd") socket.write("/workspace\r\n");
            else if (line.startsWith("echo ")) socket.write(`${line.slice(5)}\r\n`);
            else if (line.startsWith("printf ")) {
              const value = line.slice(7).replace(/^['"]|['"]$/gu, "").replaceAll("\\n", "\r\n"); socket.write(value);
            }
            socket.write("/workspace $ ");
          }
        });
        return;
      }
      if (executable === "/bin/sleep" || executable === "/usr/bin/sleep") return;
      if (executable === "/usr/bin/printf") {
        const output = args.join("").replaceAll("\\n", "\n"); if (execution.tty) socket.write(output);
      }
      setTimeout(() => { execution.Running = false; execution.ExitCode = executable.includes("false") ? 1 : 0; socket.end(); execSockets.delete(execution.ID); }, 25);
    };
    if (body.length >= contentLength) start();
    else socket.on("data", function collect(chunk) { body = Buffer.concat([body, chunk]); if (body.length >= contentLength) { socket.off("data", collect); start(); } });
  });
  await unlink(socketPath).catch((error) => { if (error.code !== "ENOENT") throw error; });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });
  return {
    close: async () => {
      await new Promise((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
      await unlink(socketPath).catch((error) => { if (error.code !== "ENOENT") throw error; });
    },
    snapshot: () => ({ networks: structuredClone([...networks.values()]), containers: structuredClone([...containers.values()]),
      execs: structuredClone([...execs.values()].map(({ input: _input, ...execution }) => execution)) }),
    driftContainer: (containerId, mutate) => {
      const container = containers.get(containerId);
      if (container === undefined) throw new Error("fixture container not found");
      mutate(container);
    },
    setContainerLifecycle: (containerId, options) => {
      if (!containers.has(containerId)) throw new Error("fixture container not found");
      lifecycles.set(containerId, { inspections: 0, ...options });
    },
    failNextContainerCreates: (count = 1) => { containerCreateFailures += count; }
  };
}
