import { createPreviewIngressConnector, readPreviewIngressConnectorOptions } from "./connector.js";

const connector = createPreviewIngressConnector(readPreviewIngressConnectorOptions());
await connector.start();
console.log(`DevSpace preview ingress connector is listening on its internal TCP port ${connector.listenPort}.`);

let shuttingDown = false;
const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  try { await connector.stop(); process.exitCode = 0; }
  catch { process.exitCode = 1; }
};
process.once("SIGINT", () => { void shutdown().catch(() => { process.exitCode = 1; }); });
process.once("SIGTERM", () => { void shutdown().catch(() => { process.exitCode = 1; }); });
