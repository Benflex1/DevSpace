import { cp, mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const packageDirectory = fileURLToPath(new URL("..", import.meta.url));
const source = fileURLToPath(new URL("../src/migrations", import.meta.url));
const destination = fileURLToPath(new URL("../dist/migrations", import.meta.url));

await mkdir(packageDirectory, { recursive: true });
await rm(destination, { recursive: true, force: true });
await cp(source, destination, { recursive: true });
