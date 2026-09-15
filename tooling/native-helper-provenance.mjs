import { createHash } from "node:crypto";
import { request as httpRequest } from "node:http";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const toolingDirectory = path.dirname(fileURLToPath(import.meta.url));
export const repositoryRoot = path.resolve(toolingDirectory, "..");
const identitySourcePath = path.join(repositoryRoot, "apps/agent/src/codex-native-helper-identity.ts");

export const NATIVE_HELPER_PLATFORM = "linux-x64";
export const NATIVE_HELPER_DOCKER_PLATFORM = "linux/amd64";
export const NATIVE_HELPER_BUILDER_IMAGE =
  "gcc:13.3.0-bookworm@sha256:50e85821c43ea2fd683bf5ae41f5d6981c41bab0641e7640962759291ceb7f78";
export const NATIVE_HELPER_BUILDER_IMAGE_DIGEST =
  "sha256:50e85821c43ea2fd683bf5ae41f5d6981c41bab0641e7640962759291ceb7f78";
export const NATIVE_HELPER_BUILDER_POLICY = "devspace-native-helper-linux-x64-v1";
export const NATIVE_HELPER_BUILDER_COMPILER = "cc (GCC) 13.3.0";
export const NATIVE_HELPER_BUILDER_LINKER = "GNU ld (GNU Binutils for Debian) 2.40";
export const NATIVE_HELPER_CANONICAL_DIRECTORY = path.join(repositoryRoot, "apps/agent/native/artifacts", NATIVE_HELPER_PLATFORM);
export const NATIVE_HELPER_DIST_DIRECTORY = path.join(repositoryRoot, "apps/agent/dist/native");
export const NATIVE_HELPER_DOCKER_SOCKET_ENV = "DEVSPACE_HELPER_BUILDER_DOCKER_SOCKET";

export const NATIVE_HELPER_BUILD_FLAGS = Object.freeze([
  "-std=c11",
  "-O2",
  "-pipe",
  "-static",
  "-Wl,--build-id=none",
  "-fno-ident",
  "-Wall",
  "-Wextra",
  "-Werror"
]);

const helperDefinitions = Object.freeze([
  Object.freeze({
    name: "codex-staged-readback",
    identityExport: "CODEX_STAGED_READBACK_HELPER_SHA256",
    sourcePath: path.join(repositoryRoot, "apps/agent/native/codex-staged-readback.c")
  }),
  Object.freeze({
    name: "codex-artifact-readback",
    identityExport: "CODEX_ARTIFACT_READBACK_HELPER_SHA256",
    sourcePath: path.join(repositoryRoot, "apps/agent/native/codex-artifact-readback.c")
  })
]);

export const NATIVE_HELPER_SOURCE_SHA256 = Object.freeze({
  "codex-staged-readback": "5ac02ace7f7eb2e2930264abd3502ccc870b128a5e6b1a7f39dbfe101e1c267c",
  "codex-artifact-readback": "0487d87ea2f4766be50897394c3cd2a34a9fa3f575887dbcbbc8ab1b373fe092"
});

function identitySource() {
  return readFileSync(identitySourcePath, "utf8");
}

export function helperNames() {
  return helperDefinitions.map((definition) => definition.name);
}

export function helperSourcePath(name) {
  const definition = helperDefinitions.find((candidate) => candidate.name === name);
  if (definition === undefined) throw new Error(`native-helper-unknown:${name}`);
  return definition.sourcePath;
}

export function trustedHelperSha256(name) {
  const definition = helperDefinitions.find((candidate) => candidate.name === name);
  if (definition === undefined) throw new Error(`native-helper-unknown:${name}`);
  const match = new RegExp(`export const ${definition.identityExport} = "([a-f0-9]{64})";`, "u").exec(identitySource());
  if (match?.[1] === undefined) throw new Error(`native-helper-trusted-identity-missing:${name}`);
  return match[1];
}

export function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function sha256File(filePath) {
  return sha256Bytes(readFileSync(filePath));
}

export function sourceSha256(name) {
  return sha256File(helperSourcePath(name));
}

export function assertTrustedHelperSource(name) {
  const expected = NATIVE_HELPER_SOURCE_SHA256[name];
  const actual = sourceSha256(name);
  if (actual !== expected) {
    throw new Error(`native-helper-source-mismatch:${name}:expected=${expected}:actual=${actual}`);
  }
}

export function assertSupportedNativeHelperTarget(platform = `${process.platform}-${process.arch}`) {
  if (platform !== NATIVE_HELPER_PLATFORM) {
    throw new Error(`native-helper-unsupported-platform:${platform}:supported=${NATIVE_HELPER_PLATFORM}`);
  }
}

export function assertTrustedHelperBytes(name, bytes) {
  const expected = trustedHelperSha256(name);
  const actual = sha256Bytes(bytes);
  if (actual !== expected) {
    throw new Error(`native-helper-integrity-mismatch:${name}:expected=${expected}:actual=${actual}`);
  }
}

function helperPath(directory, name) {
  if (path.basename(directory) === "") throw new Error("native-helper-invalid-directory");
  return path.join(directory, name);
}

export function assertHelperDirectoryMatches(expectedDirectory, actualDirectory) {
  for (const name of helperNames()) {
    const expectedPath = helperPath(expectedDirectory, name);
    const actualPath = helperPath(actualDirectory, name);
    if (!existsSync(actualPath)) throw new Error(`native-helper-missing:${actualPath}`);
    const expectedBytes = readFileSync(expectedPath);
    const actualBytes = readFileSync(actualPath);
    if (!expectedBytes.equals(actualBytes)) {
      throw new Error(`native-helper-bytes-mismatch:${name}:expected=${sha256Bytes(expectedBytes)}:actual=${sha256Bytes(actualBytes)}`);
    }
    assertTrustedHelperBytes(name, actualBytes);
  }
}

export function copyCanonicalNativeHelpers({ outputDirectory, canonicalDirectory = NATIVE_HELPER_CANONICAL_DIRECTORY }) {
  assertSupportedNativeHelperTarget();
  for (const name of helperNames()) assertTrustedHelperSource(name);
  mkdirSync(outputDirectory, { recursive: true });
  for (const name of helperNames()) {
    const sourcePath = helperPath(canonicalDirectory, name);
    if (!existsSync(sourcePath)) throw new Error(`native-helper-canonical-missing:${sourcePath}`);
    const bytes = readFileSync(sourcePath);
    assertTrustedHelperBytes(name, bytes);
    const outputPath = helperPath(outputDirectory, name);
    copyFileSync(sourcePath, outputPath);
    chmodSync(outputPath, 0o755);
    assertTrustedHelperBytes(name, readFileSync(outputPath));
  }
  return Object.fromEntries(helperNames().map((name) => [name, sha256File(helperPath(outputDirectory, name))]));
}

function dockerSocketPath() {
  const configured = process.env[NATIVE_HELPER_DOCKER_SOCKET_ENV];
  if (configured?.startsWith("unix://") === true) return configured.slice("unix://".length);
  if (configured?.startsWith("/") === true) return configured;
  const dockerHost = process.env.DOCKER_HOST;
  if (dockerHost?.startsWith("unix://") === true) return dockerHost.slice("unix://".length);
  if (existsSync("/run/devspace-docker/docker.sock")) return "/run/devspace-docker/docker.sock";
  return "/var/run/docker.sock";
}

function dockerRequest(requestPath, { method = "GET", body = Buffer.alloc(0), headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      socketPath: dockerSocketPath(),
      path: requestPath,
      method,
      headers: {
        Connection: "close",
        "Content-Length": String(body.length),
        ...headers
      }
    }, (response) => {
      const chunks = [];
      let total = 0;
      response.on("data", (chunk) => {
        total += chunk.length;
        if (total > 2 * 1024 * 1024) {
          response.destroy(new Error("native-helper-docker-response-too-large"));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => resolve({
        statusCode: response.statusCode ?? 0,
        headers: response.headers,
        body: Buffer.concat(chunks)
      }));
      response.on("error", reject);
    });
    request.on("error", reject);
    if (body.length > 0) request.write(body);
    request.end();
  });
}

function dockerResponseError(operation, response) {
  const boundedBody = [...response.body.toString("utf8", 0, 4096)].map((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 0x08 || code === 0x0b || code === 0x0c || (code >= 0x0e && code <= 0x1f) ? "?" : character;
  }).join("");
  return new Error(`native-helper-docker-${operation}-failed:${response.statusCode}:${boundedBody}`);
}

async function dockerJson(requestPath, options = {}) {
  const response = await dockerRequest(requestPath, options);
  if (response.statusCode < 200 || response.statusCode >= 300) throw dockerResponseError(requestPath, response);
  try {
    return JSON.parse(response.body.toString("utf8"));
  } catch (error) {
    throw new Error(`native-helper-docker-invalid-json:${requestPath}:${error instanceof Error ? error.message : "unknown"}`, { cause: error });
  }
}

function imagePath() {
  return `/images/${encodeURIComponent(NATIVE_HELPER_BUILDER_IMAGE)}/json`;
}

async function ensureBuilderImage() {
  let response = await dockerRequest(imagePath());
  if (response.statusCode === 404) {
    const query = new URLSearchParams({ fromImage: NATIVE_HELPER_BUILDER_IMAGE, platform: NATIVE_HELPER_DOCKER_PLATFORM });
    response = await dockerRequest(`/images/create?${query.toString()}`, { method: "POST" });
    if (response.statusCode < 200 || response.statusCode >= 300) throw dockerResponseError("image-pull", response);
    const pullErrors = response.body.toString("utf8").split("\n").filter(Boolean).flatMap((line) => {
      try {
        const record = JSON.parse(line);
        return record.error === undefined ? [] : [record.error];
      } catch {
        return [];
      }
    });
    if (pullErrors.length > 0) throw new Error(`native-helper-builder-image-pull-failed:${pullErrors.join(";")}`);
    response = await dockerRequest(imagePath());
  }
  if (response.statusCode !== 200) throw dockerResponseError("image-inspect", response);
  const image = JSON.parse(response.body.toString("utf8"));
  if (image.Os !== "linux" || image.Architecture !== "amd64") {
    throw new Error(`native-helper-builder-image-platform-mismatch:${image.Os ?? "unknown"}/${image.Architecture ?? "unknown"}`);
  }
  const repoDigests = Array.isArray(image.RepoDigests) ? image.RepoDigests : [];
  if (!repoDigests.some((digest) => digest.endsWith(`@${NATIVE_HELPER_BUILDER_IMAGE_DIGEST}`))) {
    throw new Error(`native-helper-builder-image-digest-mismatch:${repoDigests.join(",")}`);
  }
  return image;
}

function tarField(value, length) {
  const result = Buffer.alloc(length);
  Buffer.from(value).copy(result, 0, 0, Math.min(Buffer.byteLength(value), length));
  return result;
}

function tarOctal(value, length) {
  const encoded = value.toString(8).padStart(length - 1, "0");
  return Buffer.from(`${encoded}\0`);
}

function createTar(entries) {
  const blocks = [];
  for (const entry of entries) {
    const header = Buffer.alloc(512);
    tarField(entry.name, 100).copy(header, 0);
    tarOctal(entry.mode ?? 0o644, 8).copy(header, 100);
    tarOctal(0, 8).copy(header, 108);
    tarOctal(0, 8).copy(header, 116);
    tarOctal(entry.bytes.length, 12).copy(header, 124);
    tarOctal(0, 12).copy(header, 136);
    header[156] = 0x30;
    tarField("ustar\0", 8).copy(header, 257);
    tarField("00", 2).copy(header, 263);
    header.fill(0x20, 148, 156);
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    Buffer.from(checksum.toString(8).padStart(6, "0") + "\0 ").copy(header, 148);
    blocks.push(header, entry.bytes);
    const padding = (512 - (entry.bytes.length % 512)) % 512;
    if (padding > 0) blocks.push(Buffer.alloc(padding));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

function parseTarFiles(tar) {
  const files = new Map();
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/u, "");
    const sizeText = header.subarray(124, 136).toString("ascii").replace(/\0.*$/u, "").trim();
    const size = sizeText.length === 0 ? 0 : Number.parseInt(sizeText, 8);
    if (!Number.isSafeInteger(size) || size < 0 || offset + 512 + size > tar.length) throw new Error("native-helper-builder-invalid-tar");
    if (header[156] === 0x30) files.set(path.posix.basename(name), Buffer.from(tar.subarray(offset + 512, offset + 512 + size)));
    offset += 512 + size + ((512 - (size % 512)) % 512);
  }
  return files;
}

function containerName() {
  return `devspace-native-helper-builder-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function compileCommand() {
  const flags = NATIVE_HELPER_BUILD_FLAGS.join(" ");
  return [
    "set -eu",
    "export SOURCE_DATE_EPOCH=0",
    "mkdir -p /out",
    ...helperDefinitions.map((definition) => `cc ${flags} /src/${definition.name}.c -o /out/${definition.name}`),
    ...helperDefinitions.map((definition) => `chmod 0755 /out/${definition.name}`),
    "cc --version > /out/.compiler-version",
    "ld --version > /out/.linker-version"
  ].join("\n");
}

export async function buildWithPinnedNativeHelperBuilder(outputDirectory) {
  assertSupportedNativeHelperTarget();
  for (const name of helperNames()) assertTrustedHelperSource(name);
  mkdirSync(outputDirectory, { recursive: true });
  await ensureBuilderImage();
  const sourceEntries = helperDefinitions.map((definition) => ({
    name: `src/${definition.name}.c`,
    bytes: readFileSync(definition.sourcePath)
  }));
  let containerId;
  try {
    const created = await dockerJson("/containers/create?name=" + encodeURIComponent(containerName()), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: Buffer.from(JSON.stringify({
        Image: NATIVE_HELPER_BUILDER_IMAGE,
        Entrypoint: ["/bin/sh"],
        Cmd: ["-ceu", compileCommand()],
        Env: ["SOURCE_DATE_EPOCH=0"],
        HostConfig: {
          NetworkMode: "none",
          CapDrop: ["ALL"],
          SecurityOpt: ["no-new-privileges"],
          Memory: 1024 * 1024 * 1024,
          PidsLimit: 256
        }
      }))
    });
    containerId = created.Id;
    const uploaded = await dockerRequest(`/containers/${containerId}/archive?path=%2F`, {
      method: "PUT",
      headers: { "Content-Type": "application/x-tar" },
      body: createTar(sourceEntries)
    });
    if (uploaded.statusCode < 200 || uploaded.statusCode >= 300) throw dockerResponseError("source-upload", uploaded);
    const started = await dockerRequest(`/containers/${containerId}/start`, { method: "POST" });
    if (started.statusCode < 200 || started.statusCode >= 300) throw dockerResponseError("start", started);
    const waited = await dockerJson(`/containers/${containerId}/wait?condition=not-running`, { method: "POST" });
    if (waited.StatusCode !== 0) {
      const logs = await dockerRequest(`/containers/${containerId}/logs?stdout=1&stderr=1`, { method: "GET" });
      throw new Error(`native-helper-builder-failed:${waited.StatusCode}:${logs.body.toString("utf8", 0, 4096)}`);
    }
    const outputs = new Map();
    for (const name of [...helperNames(), ".compiler-version", ".linker-version"]) {
      const response = await dockerRequest(`/containers/${containerId}/archive?path=${encodeURIComponent(`/out/${name}`)}`);
      if (response.statusCode !== 200) throw dockerResponseError(`output-readback:${name}`, response);
      const files = parseTarFiles(response.body);
      const bytes = files.get(name);
      if (bytes === undefined) throw new Error(`native-helper-builder-output-missing:${name}`);
      outputs.set(name, bytes);
    }
    const compilerIdentity = outputs.get(".compiler-version").toString("utf8").trim();
    const linkerIdentity = outputs.get(".linker-version").toString("utf8").trim();
    if (!compilerIdentity.startsWith(NATIVE_HELPER_BUILDER_COMPILER)) {
      throw new Error(`native-helper-builder-compiler-mismatch:${compilerIdentity}`);
    }
    if (!linkerIdentity.startsWith(NATIVE_HELPER_BUILDER_LINKER)) {
      throw new Error(`native-helper-builder-linker-mismatch:${linkerIdentity}`);
    }
    for (const name of helperNames()) {
      const destination = helperPath(outputDirectory, name);
      writeFileSync(destination, outputs.get(name), { mode: 0o755 });
      chmodSync(destination, 0o755);
    }
    return {
      platform: NATIVE_HELPER_PLATFORM,
      builderImage: NATIVE_HELPER_BUILDER_IMAGE,
      builderImageDigest: NATIVE_HELPER_BUILDER_IMAGE_DIGEST,
      policy: NATIVE_HELPER_BUILDER_POLICY,
      sourceSha256: Object.fromEntries(helperNames().map((name) => [name, sourceSha256(name)])),
      helperSha256: Object.fromEntries(helperNames().map((name) => [name, sha256File(helperPath(outputDirectory, name))])),
      compilerIdentity,
      linkerIdentity
    };
  } finally {
    if (containerId !== undefined) {
      await dockerRequest(`/containers/${containerId}?force=1`, { method: "DELETE" }).catch(() => undefined);
    }
  }
}

export function builderProvenance() {
  return {
    policy: NATIVE_HELPER_BUILDER_POLICY,
    image: NATIVE_HELPER_BUILDER_IMAGE,
    imageDigest: NATIVE_HELPER_BUILDER_IMAGE_DIGEST,
    platform: NATIVE_HELPER_PLATFORM,
    dockerPlatform: NATIVE_HELPER_DOCKER_PLATFORM,
    flags: [...NATIVE_HELPER_BUILD_FLAGS],
    sourceSha256: Object.fromEntries(helperNames().map((name) => [name, sourceSha256(name)])),
    compiler: NATIVE_HELPER_BUILDER_COMPILER,
    linker: NATIVE_HELPER_BUILDER_LINKER
  };
}

export function temporaryBuilderOutputRoot(prefix = "devspace-native-helper-") {
  return path.join(os.tmpdir(), `${prefix}${process.pid}-${Date.now().toString(36)}`);
}
