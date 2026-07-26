import { access, mkdir, readFile, readlink, rmdir } from "node:fs/promises";
import { constants } from "node:fs";

const root = "/sys/fs/cgroup";
const child = `${root}/devspace-ai-proof-probe`;
const read = async (name) => readFile(`${root}/${name}`, "utf8").then((value) => value.trim(), () => "<missing>");
const result = {
  version: (await readFile("/proc/self/cgroup", "utf8")).startsWith("0::") ? 2 : 1,
  namespace: await readlink("/proc/self/ns/cgroup").catch(() => "<unavailable>"),
  path: (await readFile("/proc/self/cgroup", "utf8")).trim(),
  controllers: await read("cgroup.controllers"),
  subtreeControl: await read("cgroup.subtree_control"),
  killPresent: await access(`${root}/cgroup.kill`, constants.F_OK).then(() => true, () => false),
  killWritable: await access(`${root}/cgroup.kill`, constants.W_OK).then(() => true, () => false),
  delegatedChild: false,
  delegationError: null
};
try {
  await mkdir(child);
  result.delegatedChild = true;
  await rmdir(child);
} catch (error) {
  result.delegationError = error?.code === "EROFS" ? "read-only-cgroup-filesystem" : "delegation-unavailable";
}
process.stdout.write(`${JSON.stringify(result)}\n`);
