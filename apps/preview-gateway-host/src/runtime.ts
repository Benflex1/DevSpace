import {
  GatewayHostProbeServer,
  PrivatePreviewLeaseResolverTransport
} from "@devspace/gateway-caddy";

export interface PreviewGatewayHostRuntimeOptions {
  readonly probeSocketPath: string;
  readonly leaseResolverSocketPath: string;
  readonly resolverTimeoutMs?: number;
}

export interface PreviewGatewayHostRuntime {
  readonly probeSocketPath: string;
  readonly leaseResolverSocketPath: string;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export function createPreviewGatewayHostRuntime(options: PreviewGatewayHostRuntimeOptions): PreviewGatewayHostRuntime {
  const resolver = new PrivatePreviewLeaseResolverTransport({
    socketPath: options.leaseResolverSocketPath,
    ...(options.resolverTimeoutMs === undefined ? {} : { timeoutMs: options.resolverTimeoutMs })
  });
  const probe = new GatewayHostProbeServer({
    socketPath: options.probeSocketPath,
    resolveLease: async (leaseId) => await resolver.resolveLease(leaseId)
  });
  let started = false;
  return {
    probeSocketPath: options.probeSocketPath,
    leaseResolverSocketPath: options.leaseResolverSocketPath,
    async start() {
      if (started) return;
      await probe.start();
      started = true;
    },
    async stop() {
      if (!started) return;
      await probe.stop();
      started = false;
    }
  };
}
