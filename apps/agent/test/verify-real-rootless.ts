import { DockerEngineClient } from "../src/docker-runtime.js";

const socketPath = process.env.DEVSPACE_TEST_DOCKER_SOCKET_PATH;
if (socketPath === undefined) throw new Error("DEVSPACE_TEST_DOCKER_SOCKET_PATH is required; no Docker socket fallback is permitted.");
await new DockerEngineClient(socketPath).assertRootlessAvailable();
console.log("Dedicated rootless Docker Engine verification passed.");
