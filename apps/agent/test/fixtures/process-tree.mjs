import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const descendant = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)"], {
  stdio: "ignore"
});
writeFileSync(process.argv[2], String(descendant.pid));
process.stdout.write("ready\n");
if (process.argv[3] === "output") setTimeout(() => process.stdout.write("x".repeat(64 * 1024)), 200);
setInterval(() => undefined, 1_000);
