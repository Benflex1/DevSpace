import { execFileSync } from "node:child_process";
import { createPublicKey, createSign, generateKeyPairSync } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import path from "node:path";

const [fixtureRootInput, readyFileInput] = process.argv.slice(2);
if (fixtureRootInput === undefined || readyFileInput === undefined) {
  throw new Error("Usage: node installation-fixture-server.mjs <fixture-root> <ready-file>");
}
const fixtureRoot = path.resolve(fixtureRootInput);
const readyFile = path.resolve(readyFileInput);
const sourceRoot = path.join(fixtureRoot, "source");
const repositoryRoot = path.join(fixtureRoot, "repository.git");
const certificatePath = path.join(fixtureRoot, "tls-cert.pem");
const privateKeyPath = path.join(fixtureRoot, "tls-key.pem");
const issuer = "https://127.0.0.1:3443";
const audience = "devspace-installation-acceptance";
const keyId = "devspace-install-acceptance";

await mkdir(fixtureRoot, { recursive: true, mode: 0o700 });
for (const pathToCreate of [sourceRoot, repositoryRoot, certificatePath, privateKeyPath, readyFile]) {
  if (await stat(pathToCreate).then(() => true).catch(() => false)) {
    throw new Error(`Refusing to reuse installation acceptance fixture path: ${pathToCreate}`);
  }
}

execFileSync("/usr/bin/openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", privateKeyPath,
  "-out", certificatePath, "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1,DNS:localhost", "-days", "1"],
{ stdio: "ignore" });
await chmod(certificatePath, 0o644);
await chmod(privateKeyPath, 0o600);

execFileSync("/usr/bin/git", ["init", "--initial-branch=main", sourceRoot], { stdio: "ignore" });
execFileSync("/usr/bin/git", ["-C", sourceRoot, "config", "user.name", "DevSpace installation acceptance"]);
execFileSync("/usr/bin/git", ["-C", sourceRoot, "config", "user.email", "acceptance@example.invalid"]);
await writeFile(path.join(sourceRoot, "README.md"), "Disposable DevSpace installation acceptance repository.\n", "utf8");
execFileSync("/usr/bin/git", ["-C", sourceRoot, "add", "README.md"]);
execFileSync("/usr/bin/git", ["-C", sourceRoot, "commit", "-m", "installation acceptance fixture"], { stdio: "ignore" });
execFileSync("/usr/bin/git", ["clone", "--bare", sourceRoot, repositoryRoot], { stdio: "ignore" });
execFileSync("/usr/bin/git", ["--git-dir", repositoryRoot, "update-server-info"]);

const accessKeys = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" }
});
const privateAccessKey = accessKeys.privateKey;
const publicJwk = createPublicKey(accessKeys.publicKey).export({ format: "jwk" });
const jwks = JSON.stringify({ keys: [{ kty: publicJwk.kty, n: publicJwk.n, e: publicJwk.e, use: "sig", alg: "RS256", kid: keyId }] });

function createAccessToken() {
  const now = Math.floor(Date.now() / 1_000);
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const signingInput = `${encode({ alg: "RS256", typ: "JWT", kid: keyId })}.${encode({
    iss: issuer, aud: audience, sub: "devspace-installation-acceptance", email: "owner@example.invalid",
    iat: now, exp: now + 600
  })}`;
  const signer = createSign("RSA-SHA256");
  signer.update(signingInput);
  signer.end();
  return `${signingInput}.${signer.sign(privateAccessKey, "base64url")}`;
}

function sendFile(request, response, pathname) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405).end();
    return;
  }
  if (request.socket.remoteAddress !== "127.0.0.1") {
    response.writeHead(403).end();
    return;
  }
  if (pathname !== "/repository.git" && !pathname.startsWith("/repository.git/")) {
    response.writeHead(404).end();
    return;
  }
  const target = path.resolve(repositoryRoot, `.${decodeURIComponent(pathname.slice("/repository.git".length))}`);
  if (target !== repositoryRoot && !target.startsWith(`${repositoryRoot}${path.sep}`)) {
    response.writeHead(404).end();
    return;
  }
  void stat(target).then((details) => {
    if (!details.isFile()) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, {
      "content-length": details.size,
      "content-type": pathname.endsWith("/info/refs") ? "text/plain" : "application/octet-stream",
      "cache-control": "no-store"
    });
    if (request.method === "HEAD") response.end();
    else createReadStream(target).pipe(response);
  }).catch(() => response.writeHead(404).end());
}

const tlsOptions = { key: await readFile(privateKeyPath), cert: await readFile(certificatePath) };
const fixtures = https.createServer(tlsOptions, (request, response) => {
  const pathname = new URL(request.url ?? "/", issuer).pathname;
  if (request.socket.remoteAddress !== "127.0.0.1") {
    response.writeHead(403).end();
  } else if (request.method === "GET" && pathname === "/health") {
    response.writeHead(200, { "content-type": "text/plain" }).end("ready\n");
  } else if (request.method === "GET" && pathname === "/cdn-cgi/access/certs") {
    response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }).end(jwks);
  } else if (request.method === "GET" && pathname === "/access-token") {
    response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" })
      .end(JSON.stringify({ token: createAccessToken() }));
  } else {
    sendFile(request, response, pathname);
  }
});

function writeUpgradedResponse(response, upstreamHead, clientSocket, upstreamSocket, clientHead) {
  const statusLine = `HTTP/${response.httpVersion} ${response.statusCode} ${response.statusMessage}`;
  const headerLines = Object.entries(response.headers).flatMap(([name, value]) => {
    if (value === undefined) return [];
    return (Array.isArray(value) ? value : [value]).map((item) => `${name}: ${item}`);
  });
  clientSocket.write(`${[statusLine, ...headerLines, "", ""].join("\r\n")}`);
  if (upstreamHead.length) clientSocket.write(upstreamHead);
  if (clientHead.length) upstreamSocket.write(clientHead);
  clientSocket.pipe(upstreamSocket);
  upstreamSocket.pipe(clientSocket);
  upstreamSocket.once("error", () => clientSocket.destroy());
  clientSocket.once("error", () => upstreamSocket.destroy());
}

const webProxy = https.createServer(tlsOptions, (request, response) => {
  const upstream = http.request({ hostname: "127.0.0.1", port: 3000, method: request.method,
    path: request.url, headers: request.headers }, (upstreamResponse) => {
    response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
    upstreamResponse.pipe(response);
  });
  upstream.once("error", () => {
    if (!response.headersSent) response.writeHead(502);
    response.end();
  });
  request.pipe(upstream);
});
webProxy.on("upgrade", (request, clientSocket, clientHead) => {
  const upstream = http.request({ hostname: "127.0.0.1", port: 3000, method: request.method,
    path: request.url, headers: request.headers });
  upstream.on("upgrade", (response, upstreamSocket, upstreamHead) => {
    writeUpgradedResponse(response, upstreamHead, clientSocket, upstreamSocket, clientHead);
  });
  upstream.on("response", (response) => {
    const headerLines = Object.entries(response.headers).flatMap(([name, value]) => {
      if (value === undefined) return [];
      return (Array.isArray(value) ? value : [value]).map((item) => `${name}: ${item}`);
    });
    clientSocket.write(`${[`HTTP/${response.httpVersion} ${response.statusCode} ${response.statusMessage}`, ...headerLines, "", ""].join("\r\n")}`);
    response.pipe(clientSocket);
  });
  upstream.once("error", () => clientSocket.destroy());
  upstream.end();
});

async function listen(server, port) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
}

await listen(fixtures, 3443);
await listen(webProxy, 3444);
await writeFile(readyFile, `${JSON.stringify({ fixtureRoot })}\n`, { mode: 0o600 });
console.log("Installation acceptance fixtures listening on loopback ports 3443 and 3444.");

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await Promise.all([fixtures, webProxy].map(async (server) => await new Promise((resolve) => server.close(resolve))));
  process.exitCode = 0;
}
process.once("SIGINT", () => { void stop(); });
process.once("SIGTERM", () => { void stop(); });
