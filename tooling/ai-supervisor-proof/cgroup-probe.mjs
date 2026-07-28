import { access, mkdir, readFile, readlink, rmdir } from "node:fs/promises";
import { constants } from "node:fs";

const root = "/sys/fs/cgroup";
const child = `${root}/devspace-ai-proof-probe`;
const read = async (name) => readFile(`${root}/${name}`, "utf8")
  .then((value) => value.trim(), () => "<missing>");
const split = (value) => value === "" ? [] : value.split(/\s+/u).sort();
const mounts = await readFile("/proc/mounts", "utf8").catch(() => "");
const cgroupMount = mounts.split("\n").find((line) => line.split(" ")[1] === root);
const result = {
  version: (await readFile("/proc/self/cgroup", "utf8")).startsWith("0::") ? 2 : 1,
  namespace: await readlink("/proc/self/ns/cgroup").catch(() => "<unavailable>"),
  path: (await readFile("/proc/self/cgroup", "utf8")).trim(),
  mountReadOnly: cgroupMount?.split(" ")[3]?.split(",").includes("ro") ?? null,
  controllers: split(await read("cgroup.controllers")),
  subtreeControl: split(await read("cgroup.subtree_control")),
  killPresent: await access(`${root}/cgroup.kill`, constants.F_OK).then(() => true, () => false),
  killWritable: await access(`${root}/cgroup.kill`, constants.W_OK).then(() => true, () => false),
  delegatedChild: false,
  childCreation: "unavailable"
};
try {
  await mkdir(child);
  result.delegatedChild = true;
  result.childCreation = "created";
  await rmdir(child);
} catch (error) {
  result.childCreation = error?.code === "EROFS"
    ? "read-only"
    : error?.code === "EACCES" || error?.code === "EPERM"
      ? "permission-denied"
      : "unavailable";
}
process.stdout.write(`${JSON.stringify(result)}\n`);
