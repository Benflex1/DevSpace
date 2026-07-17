import net from "node:net";

const server = net.createServer();
server.listen(process.argv[2], () => process.stdout.write("ready\n"));
setInterval(() => undefined, 1_000);
