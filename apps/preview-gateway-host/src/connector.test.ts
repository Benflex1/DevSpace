import net from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { createPreviewIngressConnector } from "./connector.js";

const roots: string[] = [];
const servers: net.Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => await new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
});

async function freePort(): Promise<number> {
  const server = net.createServer();
  servers.push(server);
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("port-missing");
  const port = address.port;
  await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
  servers.splice(servers.indexOf(server), 1);
  return port;
}

function connect(port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1");
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });
}

test("forwards HTTP bytes, including the original Host header, unchanged", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devspace-preview-ingress-"));
  roots.push(root);
  const socketPath = path.join(root, "preview-http.sock");
  const upstream = net.createServer((socket) => {
    socket.once("data", (data) => {
      expect(data.toString("utf8")).toContain("Host: chess-a8f3-preview.benflex.dev");
      socket.end("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok");
    });
  });
  servers.push(upstream);
  upstream.on("error", () => undefined);
  await new Promise<void>((resolve, reject) => { upstream.once("error", reject); upstream.listen(socketPath, resolve); });
  const connector = createPreviewIngressConnector({ listenPort: await freePort(), listenHost: "127.0.0.1", previewHttpSocketPath: socketPath });
  await connector.start();
  const client = await connect(connector.listenPort);
  const response = new Promise<string>((resolve) => { const chunks: Buffer[] = []; client.on("data", (chunk) => chunks.push(chunk)); client.once("end", () => resolve(Buffer.concat(chunks).toString("utf8"))); });
  client.write("GET / HTTP/1.1\r\nHost: chess-a8f3-preview.benflex.dev\r\nConnection: close\r\n\r\n");
  await expect(response).resolves.toContain("HTTP/1.1 200 OK");
  await connector.stop();
});

test("forwards upgraded bidirectional bytes without parsing the protocol", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devspace-preview-ingress-"));
  roots.push(root);
  const socketPath = path.join(root, "preview-http.sock");
  const upstream = net.createServer((socket) => {
    socket.once("data", (data) => {
      expect(data.toString("utf8")).toContain("Upgrade: websocket");
      socket.write("101-switch-response");
      socket.once("data", (reply) => socket.end(Buffer.concat([Buffer.from("echo:"), reply])));
    });
  });
  servers.push(upstream);
  upstream.on("error", () => undefined);
  await new Promise<void>((resolve, reject) => { upstream.once("error", reject); upstream.listen(socketPath, resolve); });
  const connector = createPreviewIngressConnector({ listenPort: await freePort(), listenHost: "127.0.0.1", previewHttpSocketPath: socketPath });
  await connector.start();
  const client = await connect(connector.listenPort);
  const chunks: Buffer[] = [];
  client.on("data", (chunk) => chunks.push(chunk));
  client.write("GET /socket HTTP/1.1\r\nHost: chess-a8f3-preview.benflex.dev\r\nUpgrade: websocket\r\n\r\n");
  await new Promise<void>((resolve) => client.once("data", () => resolve()));
  client.write("binary-frame");
  await new Promise<void>((resolve) => client.once("end", resolve));
  expect(Buffer.concat(chunks).toString("utf8")).toContain("101-switch-response");
  expect(Buffer.concat(chunks).toString("utf8")).toContain("echo:binary-frame");
  await connector.stop();
});

test("closes the client when the private data-plane socket is unavailable", async () => {
  const connector = createPreviewIngressConnector({ listenPort: await freePort(), listenHost: "127.0.0.1", previewHttpSocketPath: "/tmp/devspace-preview-ingress-missing.sock" });
  await connector.start();
  const client = await connect(connector.listenPort);
  await new Promise<void>((resolve) => client.once("close", () => resolve()));
  await connector.stop();
});
