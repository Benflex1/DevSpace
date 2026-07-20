import { createPreviewGatewayHostRuntime } from "./runtime.js";

function requiredSocket(environmentName: string): string {
  const value = process.env[environmentName];
  if (value === undefined || value.trim() === "") throw new Error(`${environmentName} must be a non-empty private Unix-socket path.`);
  return value;
}

const runtime = createPreviewGatewayHostRuntime({
  probeSocketPath: requiredSocket("DEVSPACE_PREVIEW_PROBE_SOCKET"),
  leaseResolverSocketPath: requiredSocket("DEVSPACE_PREVIEW_LEASE_RESOLVER_SOCKET")
});
await runtime.start();
console.log("DevSpace preview gateway host probe is listening on a private Unix socket.");

let shuttingDown = false;
const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    await runtime.stop();
    process.exitCode = 0;
  } catch {
    process.exitCode = 1;
  }
};
process.once("SIGINT", () => { void shutdown().catch(() => { process.exitCode = 1; }); });
process.once("SIGTERM", () => { void shutdown().catch(() => { process.exitCode = 1; }); });
