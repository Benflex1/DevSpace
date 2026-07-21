import net from "node:net";

const defaultPort = 8080;

export interface PreviewIngressConnectorOptions {
  readonly listenHost?: string;
  readonly listenPort: number;
  readonly previewHttpSocketPath: string;
  readonly log?: (message: string) => void;
}

export interface PreviewIngressConnector {
  readonly listenPort: number;
  readonly previewHttpSocketPath: string;
  start(): Promise<void>;
  stop(): Promise<void>;
}

function boundedPort(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 65535) throw new Error("Preview ingress port is invalid.");
  return value;
}

/**
 * A deliberately byte-transparent outer-ingress adapter. It has no HTTP
 * parser, so Host headers, upgrades, and arbitrary request bytes are retained.
 */
export function createPreviewIngressConnector(options: PreviewIngressConnectorOptions): PreviewIngressConnector {
  const listenPort = boundedPort(options.listenPort);
  if (options.previewHttpSocketPath.trim() === "") throw new Error("Preview HTTP socket path is required.");
  const listenHost = options.listenHost ?? "0.0.0.0";
  const log = options.log ?? ((message) => console.error(`[preview-ingress] ${message}`));
  const server = net.createServer({ allowHalfOpen: true }, (client) => {
    client.pause();
    const upstream = net.createConnection({ path: options.previewHttpSocketPath });
    let connected = false;
    let closed = false;
    const closePair = () => {
      if (closed) return;
      closed = true;
      client.destroy();
      upstream.destroy();
    };
    client.once("error", closePair);
    upstream.once("error", () => {
      if (!connected) log("preview gateway data-plane socket is unavailable");
      closePair();
    });
    client.once("close", () => upstream.destroy());
    upstream.once("close", () => client.destroy());
    upstream.once("connect", () => {
      connected = true;
      client.pipe(upstream, { end: false });
      upstream.pipe(client, { end: false });
      client.resume();
    });
    client.once("end", () => upstream.end());
    upstream.once("end", () => client.end());
  });
  server.on("error", (error) => log(`connector listener error: ${error instanceof Error ? error.message.slice(0, 160) : "unknown"}`));
  let started = false;
  return {
    listenPort,
    previewHttpSocketPath: options.previewHttpSocketPath,
    async start() {
      if (started) return;
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => { server.off("listening", onListening); reject(error); };
        const onListening = () => { server.off("error", onError); resolve(); };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(listenPort, listenHost);
      });
      started = true;
    },
    async stop() {
      if (!started) return;
      await new Promise<void>((resolve) => server.close(() => resolve()));
      started = false;
    }
  };
}

export function readPreviewIngressConnectorOptions(environment: NodeJS.ProcessEnv = process.env): PreviewIngressConnectorOptions {
  const rawPort = environment.DEVSPACE_PREVIEW_INGRESS_PORT?.trim();
  const listenPort = rawPort === undefined || rawPort === "" ? defaultPort : Number(rawPort);
  if (!Number.isSafeInteger(listenPort) || listenPort < 1 || listenPort > 65535) {
    throw new Error("DEVSPACE_PREVIEW_INGRESS_PORT must be a valid TCP port.");
  }
  const socketPath = environment.DEVSPACE_PREVIEW_HTTP_SOCKET?.trim();
  if (socketPath === undefined || socketPath === "") throw new Error("DEVSPACE_PREVIEW_HTTP_SOCKET must be a non-empty Unix-socket path.");
  return { listenPort, previewHttpSocketPath: socketPath, listenHost: environment.DEVSPACE_PREVIEW_INGRESS_HOST?.trim() || "0.0.0.0" };
}
